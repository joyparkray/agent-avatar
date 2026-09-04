//! Hermes 适配层 —— **可整体摘除的边界**（M1 §1.2）。
//!
//! 删掉本文件与 `lib.rs` 里的 `mod hermes;` / 两个 handler 注册后，应用仍然完整可用：
//! 前端 `invoke` 调不到命令会走 `SemanticDriver` 的失败降级（常驻 idle），
//! 文件 / 全局音源与形象动作完全不受影响。配套的 hook 见 `integrations/hermes/`。
use serde_json::Value;
use std::{env, fs, io::{Read, Write}, net::{TcpStream, ToSocketAddrs}, path::{Path, PathBuf}, time::{Duration, SystemTime}};

/// 把状态文件收敛成 SemanticDriver 只认的 `{state, sequence}`。
///
/// 顶层扁平结构是 Agent Avatar 自己的 hook 写的。Star Office 的嵌套 schema
/// （`desired.update.state` / `last_push.state`）已在 M1 解耦后不再兼容：
/// 取不出顶层 `state` 的文件一律返回 None（当作「这个候选不存在」继续找下一个）。
/// 这条是永久的：原来任何能解析的 JSON 都算命中，schema 不兼容时 `snapshot.state`
/// 恒为 undefined，前端会静默地一直是 idle —— 不报错、看着像接上了，实际永远不变脸。
fn normalize_semantic_state(value: &Value) -> Option<Value> {
    let state = value.get("state")
        .and_then(Value::as_str)?;
    let sequence = value.get("sequence").and_then(Value::as_u64).unwrap_or(0);
    // hook 顺带把 Hermes 的会话 token 带出来（见 `discover_audio_endpoint`）。
    let token = value.pointer("/audio/token").and_then(Value::as_str);
    // reaction 是叠加层（blocked/interrupted）：形状合法（kind+sequence）才透传，否则 null。
    // `at` 是前端的去重键（hook 的单调时间戳）；缺失时给 0，让老快照退化成「每种反应触发一次」
    // 而不是整条丢掉。sequence 仍透传，但它存在易失的 .sessions 里、会复位，不能当门。
    let reaction = value.pointer("/reaction").and_then(Value::as_object).and_then(|r| {
        let kind = r.get("kind").and_then(Value::as_str)?;
        let sequence = r.get("sequence").and_then(Value::as_u64)?;
        let at = r.get("at").and_then(Value::as_f64).unwrap_or(0.0);
        Some(serde_json::json!({ "kind": kind, "sequence": sequence, "at": at }))
    });
    // 「它具体在干嘛」的一行。挑白名单是 Python 侧的事（见 state_machine.activity_from），
    // 这里只负责**别让它无限长** —— 这个字段最终会被贴进状态栏，而状态栏没有宽度上限。
    // 上游已经截到 80 字符（两行的实际容量），这条是防「快照被手改过 / 版本不一致」的第二道。
    let doing = value.get("doing").and_then(Value::as_str)
        .map(|text| text.chars().take(80).collect::<String>());
    Some(serde_json::json!({ "state": state, "sequence": sequence, "token": token, "reaction": reaction, "doing": doing }))
}
/// 忙态快照多久算过期。与上游 hook 的会话过期口径一致。
const STATE_STALE_SECONDS: u64 = 300;
fn read_state_file(path: &Path) -> Option<Value> {
    let mut value = normalize_semantic_state(&serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?)?;
    // 快照本身没有「过期」的概念：会话被杀、或最后一个收尾事件没跑到时，最后写下的忙态会永远
    // 留在文件里，皮肤就一直卡在那个表情。idle 不需要这条 —— 它本来就是静止态。
    let stale = fs::metadata(path).ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|at| SystemTime::now().duration_since(at).ok())
        .is_some_and(|age| age.as_secs() > STATE_STALE_SECONDS);
    if stale && value["state"] != "idle" { value["state"] = Value::String("idle".to_owned()); }
    Some(value)
}
/// 候选状态文件按修改时间从新到旧排。
///
/// 固定优先级会出事：迁移期两个 hook 的文件并存，只写过一次的那个排在前面就会**盖住正在更新的**，
/// 表现为状态永远停在某一格。同一个坑也适用于上次开机遗留的文件。取最新的那个才是「谁在写听谁的」。
/// 同 `newest_first`，但把每条路径原来属于哪一家一起带过去 —— 「自动」模式要把它标进快照。
fn newest_first_tagged(paths: Vec<(&'static str, PathBuf)>) -> Vec<(&'static str, PathBuf)> {
    let mut dated: Vec<_> = paths.into_iter()
        .filter_map(|(harness, path)| {
            fs::metadata(&path).ok()?.modified().ok().map(|at| (at, harness, path))
        })
        .collect();
    dated.sort_by(|left, right| right.0.cmp(&left.0));
    dated.into_iter().map(|(_, harness, path)| (harness, path)).collect()
}

fn newest_first(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut dated: Vec<_> = paths.into_iter()
        .filter_map(|path| fs::metadata(&path).ok()?.modified().ok().map(|at| (at, path)))
        .collect();
    dated.sort_by(|left, right| right.0.cmp(&left.0));
    dated.into_iter().map(|(_, path)| path).collect()
}
/// 认得的 harness。**这是白名单**：`source` 会被拼进文件名，不能让任意字符串进来。
/// 顺序即「自动」模式的候选顺序（实际由 mtime 决定，这里只是枚举）。
const HARNESSES: [&str; 5] = ["hermes", "claude-code", "codex", "workbuddy", "dsh"];

/// 某个 harness 的快照文件名。Hermes 沿用无后缀的老路径 —— 已经装好的用户不该断掉。
/// 与 Python 侧 `core/state_machine.py: state_path()` 必须保持一致。
fn state_file_name(harness: &str) -> String {
    if harness == "hermes" { "agent-avatar-state.json".to_owned() }
    else { format!("agent-avatar-state.{harness}.json") }
}

/// 装机时留下的那条**验证**记录；没有 = None。
///
/// 注意它记的不是「我装了」——「装没装」的权威答案在 harness 自己的账本里，
/// 自报一句反而更弱。它记的是账本答不了的那件事：**装的时候在这台机器上把 hook
/// 真正跑通过一次**（`localize.py` 的冒烟自检：喂一条真事件、验到状态文件落盘）。
///
/// 它补的是中间那一档的空白：「装了但从没上报」在刚装完的几分钟里是**正常的**
/// （还没开新会话），过了一天就是**故障**。有了这条记录，界面能把两者分开说。
pub fn install_record(harness: &str) -> Option<Value> {
    let name = format!("agent-avatar-install.{}.json", harness);
    let newest = candidates(&name).into_iter()
        .filter_map(|path| Some((fs::metadata(&path).ok()?.modified().ok()?, path)))
        .max_by_key(|(at, _)| *at)
        .map(|(_, path)| path)?;
    serde_json::from_str(&fs::read_to_string(newest).ok()?).ok()
}

/// hook 最后一次出错时留下的那条记录；从没出过错 = None。
///
/// 这是三层诊断里的**第 2 层**：hook 跑起来了、但事件没处理成
/// （core 漏拷、事件解析炸、状态文件写不进去）。这种失败原来只写 stderr，
/// 而**没人在看** —— dsh 那条链路直接把子进程的 stderr 设成 `ignore`。
/// 有了这个文件，界面就能说出**具体原因**，而不是只显示「装了但不动」。
pub fn last_diagnostic(harness: &str) -> Option<Value> {
    let name = format!("agent-avatar-diagnostic.{}.json", harness);
    let newest = candidates(&name).into_iter()
        .filter_map(|path| Some((fs::metadata(&path).ok()?.modified().ok()?, path)))
        .max_by_key(|(at, _)| *at)
        .map(|(_, path)| path)?;
    serde_json::from_str(&fs::read_to_string(newest).ok()?).ok()
}

/// 这家 harness 上报的 connector 版本；没上报过或旧版 connector 没写这个字段 = None。
///
/// **为什么需要它**：Windows 上装的是**本地化过的副本**（解释器绝对路径写死在里面），
/// 所以它收不到 harness 的自动更新 —— 换来的是「更新是显式的」，代价是得有人告诉用户
/// 有新版。app 本来就在读这个文件，于是它能准确说出「你装的是 1.0.0，最新 1.2.0」。
///
/// 读的是**最新的那一份**：同一家可能在多个临时目录下留过文件（TMPDIR 变过），
/// 拿旧的那份的版本号去比，会把已经更新过的用户一直标成过期。
pub fn reported_connector_version(harness: &str) -> Option<String> {
    let newest = candidate_paths(harness).into_iter()
        .filter_map(|path| Some((fs::metadata(&path).ok()?.modified().ok()?, path)))
        .max_by_key(|(at, _)| *at)
        .map(|(_, path)| path)?;
    let raw = fs::read_to_string(newest).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get("connector_version")?.as_str().map(str::to_owned)
}

/// 这家 harness 的 hook 最后一次写状态文件是多久以前（秒）；从没写过 = None。
///
/// **这是「链路通没通」的唯一真信号**：插件目录在不在只说明文件装了，而没 enable（Hermes）、
/// 没授信（Codex）、没重启（WorkBuddy）时目录照样在，用户看到的是「已安装但形象不动」。
/// 状态文件是 hook 真的跑起来才会出现的东西。
///
/// 由 `connectors.rs` 用来显示接入状态 —— 文件名与落点的单一真相在本模块（对齐 Python 侧
/// `bridge/state_machine.py: state_path()`），不在那边复制一份。
pub fn last_signal_seconds(harness: &str) -> Option<u64> {
    candidate_paths(harness).into_iter()
        .filter_map(|path| fs::metadata(&path).ok()?.modified().ok())
        .filter_map(|at| SystemTime::now().duration_since(at).ok())
        .map(|age| age.as_secs())
        .min()
}

fn candidate_paths(harness: &str) -> Vec<PathBuf> {
    candidates(&state_file_name(harness))
}

/// 某个文件名在各个可能的临时目录下的位置。状态文件与诊断文件共用这一份落点规则 ——
/// 两边各写一份必然会漂，而漂了之后表现是「诊断文件明明写了，app 就是读不到」。
fn candidates(name: &str) -> Vec<PathBuf> {
    let mut paths = vec![];
    // 顺序要跟 **Python 侧** `state_machine.state_path()` 对齐 —— 它用的是
    // `tempfile.gettempdir()`，而那函数先看 `TMPDIR`，再退到系统默认临时目录。
    // 两边算出不同的位置，结果就是 Rust 永远读不到 bridge 写的状态文件，
    // 而且完全静默：桌宠一直显示 idle，没有任何报错。
    if let Ok(dir) = env::var("TMPDIR") { paths.push(PathBuf::from(&dir).join(name)); }
    paths.push(env::temp_dir().join(name));
    // macOS 上 TMPDIR 是每用户/每会话的 `/var/folders/...`，而 harness 若由 launchd、cron
    // 或别的用户拉起，拿到的 TMPDIR 不同 —— 原来这条 `/tmp` 兜底就是为这个，保留。
    // Windows 上没有对应概念（`/tmp` 会被解析成当前盘根目录），所以只在 unix 上加。
    #[cfg(unix)]
    paths.push(PathBuf::from("/tmp").join(name));
    paths.dedup();
    paths
}

/// 详情那一行的开关，**写给 hook 看**。
///
/// 🔴 开关不能只做在界面上。关掉的时候我们要的是「工具信息根本不被写进磁盘」，而写文件的
/// 是 hook（一个独立的 Python 进程，读不到 app 的配置）。所以约定一个它认得的文件：
/// **只有 `{"activity": true}` 才算开；文件不在、读不动、或者写着别的，一律算关。**
/// 对应 `state_machine.activity_allowed()`，那边是 `.get("activity") is True`。
///
/// ⚠️ 这里原来写的是「没有这个文件 = 开着」，**和实现正好相反**。默认关是故意的，
/// 而且默认值必须两边一致：这个开关的全部意义就是关着的时候工具名和文件名根本不落盘，
/// 默认开会让从没要过这个功能的用户也在往磁盘上写。
///
/// 写到**每一个候选临时目录**：hook 与 app 算出的 tmp 未必是同一个（`candidates` 那段注释
/// 讲了为什么），只写一个的话开关可能对某些 harness 无效 —— 而那种失效是完全静默的。
#[tauri::command(async)]
pub fn set_activity_detail(enabled: bool) -> Result<(), String> {
    let body = serde_json::json!({ "activity": enabled }).to_string();
    let mut wrote = 0usize;
    let mut last = String::new();
    for path in candidates("agent-avatar-options.json") {
        match fs::write(&path, &body) {
            Ok(()) => wrote += 1,
            Err(error) => last = format!("{}: {error}", path.display()),
        }
    }
    if wrote > 0 { Ok(()) } else { Err(format!("写不进开关文件（{last}）")) }
}

/// `(async)`：Tauri 的同步 command 在**主线程**执行（官方文档：「Commands without the async
/// keyword are executed on the main thread」）。这条以 5Hz 被轮询，读文件虽轻，但没有理由
/// 和渲染抢主线程。函数体是阻塞 I/O，故用 `(async)` 丢到线程池，而不是改成 `async fn`。
///
/// `source`：右键菜单里的「状态来源」。`None`/`"auto"` = 谁在写听谁的（按 mtime 取最新，
/// 老行为）；`"off"` = 不读（常驻 idle）；具体 harness 名 = 只读那一家。
/// 同时开着多个 agent 时，「自动」会让形象跟着最近活动的那个走；想钉死就选具体一家。
#[tauri::command(async)]
pub fn read_semantic_state(source: Option<String>) -> Option<Value> {
    // 显式指定是用户意图，压过一切
    if let Ok(path) = env::var("AGENT_AVATAR_STATE_PATH") { return read_state_file(&PathBuf::from(path)); }
    let harnesses = sources_to_search(source.as_deref())?;
    // 🔴 **只有「自动」下才标来源。** 钉死某一家时用户已经知道在看谁，多一个前缀是噪音；
    // 而「自动」是「谁最近写就听谁的」，同时开着两个 agent 时状态栏会在它们之间跳，
    // 用户完全不知道自己在看哪一家 —— 2026-09-04 实机就栽在这儿：一个 Claude Code 会话
    // 每调一次工具就写一次状态文件，一直压过正在被测的 Hermes，看起来像 Hermes 坏了。
    let mark_source = marks_source(source.as_deref());
    let paths: Vec<(&'static str, PathBuf)> = harnesses.iter()
        .flat_map(|h| candidate_paths(h).into_iter().map(move |path| (*h, path)))
        .collect();
    newest_first_tagged(paths).into_iter().find_map(|(harness, path)| {
        let mut value = read_state_file(&path)?;
        if mark_source {
            if let Some(object) = value.as_object_mut() {
                object.insert("source".to_owned(), Value::String(harness.to_owned()));
            }
        }
        Some(value)
    })
}

/// 这一条状态要不要标出是谁写的。**只有「自动」下才标。**
///
/// 🔴 钉死某一家时用户已经知道在看谁，多一个前缀是噪音；而「自动」是「谁最近写就听谁的」，
/// 同时开着两个 agent 时状态栏会在它们之间跳，用户完全不知道自己在看哪一家。
/// 2026-09-04 实机就栽在这儿 —— 一个 Claude Code 会话每调一次工具就写一次状态文件，
/// 一直压过正在被测的 Hermes，看起来像 Hermes 坏了，查了很久才发现是显示被抢。
fn marks_source(source: Option<&str>) -> bool {
    matches!(source, None | Some("auto"))
}

/// 把「状态来源」设置解析成要查的 harness 列表。`None` = 关闭（常驻 idle）。
///
/// **白名单之外的值一律当「自动」**，且返回的是 `&'static str` 而不是调用方给的字符串 ——
/// 这个值会被拼进文件名，绝不能让任意输入流到路径里去。
fn sources_to_search(source: Option<&str>) -> Option<Vec<&'static str>> {
    match source {
        Some("off") => None,
        Some(name) => Some(match HARNESSES.iter().find(|known| **known == name) {
            Some(known) => vec![*known],
            None => HARNESSES.to_vec(),
        }),
        None => Some(HARNESSES.to_vec()),
    }
}
/// lsof 输出里所有在监听的回环端口。
///
/// 按名字找 Hermes 是行不通的：COMMAND 列被截断成 9 字符（Hermes web 显示为 `python3.1`），
/// 而 USER 列在开发机上恰好就是 `hermes`。原来的 `line.contains("hermes")` 因此命中每一行，
/// 实际连上的是排在最前面的任意本地服务（实测是 ollama:11434）。
/// 改成「枚举端口 + 逐个握手」，身份由 `/api/status` 自证。
///
/// 只有 macOS 用得上 —— 它解析的是 `lsof` 的输出，而 Windows 上没有 lsof，
/// `platform::listening_ports()` 在那边直接返回空（见 platform/windows.rs）。
/// 加 cfg 而不是留着不用，是为了不在 Windows 上积一份编得过但永远跑不到的死代码。
#[cfg(target_os = "macos")]
pub(crate) fn parse_listening_ports(lsof_output: &str) -> Vec<u16> {
    let mut ports: Vec<u16> = lsof_output.lines().skip(1)
        .filter_map(|line| line.split_whitespace().find(|part| part.starts_with("127.0.0.1:") || part.starts_with("*:")))
        .filter_map(|name| name.rsplit(':').next()?.parse().ok())
        .collect();
    ports.sort_unstable(); ports.dedup(); ports
}
/// Hermes web 的自证握手。`/api/status` 是它的机器级公开存活探针（不需要认证），
/// 只有同时给出这两个字段的才当成 Hermes，避免把本机其它监听端口误认。
fn hermes_status(url: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(&fetch_path(url, "/api/status").ok()?).ok()?;
    (value.get("gateway_running").is_some() && value.get("config_version").is_some()).then_some(value)
}
/// `(async)`：**必须**离开主线程。函数体是 `lsof` 子进程 + 对每个监听端口的串行 HTTP 握手
/// （connect 2s + read 2s），本机十来个监听端口就能把窗口冻住几十秒；开着 docker/多 dev server
/// 的机器更糟。而且 `retarget`（token 变化）会在运行中再触发一次。
#[tauri::command(async)]
pub fn discover_audio_endpoint() -> Option<Value> {
    let (url, status) = match env::var("AGENT_AVATAR_AUDIO_ENDPOINT") {
        // 显式指定是用户意图，Hermes 还没起也照样返回，让 WS 自己去失败。
        Ok(url) => { let status = hermes_status(&url); (url, status) }
        Err(_) => {
            crate::platform::listening_ports().into_iter()
                .map(|port| format!("http://127.0.0.1:{port}"))
                .find_map(|url| hermes_status(&url).map(|status| (url, Some(status))))?
        }
    };
    // token 三个来源，按「显式 > hook 带出 > 首页抓」排：
    // - 环境变量：调试与手工覆盖；
    // - **状态文件**：Hermes desktop 拉起的是 `hermes serve`（headless，首页 404），
    //   HTML 里根本没有 token 可抓，而那恰恰是音频真正会流动的场景。desktop 会把 token 放进
    //   后端进程的环境变量，hook 继承得到并写进状态文件，皮肤从那儿读；
    // - 首页 HTML：`hermes dashboard` 且未开认证时可用（老路径）。
    // 开了认证则三者都拿不到，WS 会被 4401 关掉，故一并把 auth_required 带回前端区分。
    let token = env::var("AGENT_AVATAR_AUDIO_TOKEN").ok().filter(|value| !value.is_empty())
        // ⚠️ 固定读 **Hermes** 那份快照，不跟随「状态来源」设置：
        // 否则用户把状态来源切到 Codex，Hermes 的音频 token 就没了、口型静默断掉。
        // 这两件事本来就无关 —— 一个是「显示谁的状态」，一个是「音频从哪来」。
        .or_else(|| newest_first(candidate_paths("hermes")).into_iter()
            .find_map(|path| read_state_file(&path))?
            .get("token")?.as_str().map(str::to_owned))
        .or_else(|| fetch_path(&url, "/").ok().and_then(|html| extract_session_token(&html)));
    let auth_required = status.as_ref().and_then(|value| value.get("auth_required")).and_then(Value::as_bool).unwrap_or(false);
    Some(serde_json::json!({ "url": url, "token": token, "auth_required": auth_required }))
}

fn extract_session_token(html: &str) -> Option<String> {
    let marker = "window.__HERMES_SESSION_TOKEN__";
    let tail = html.split_once(marker)?.1;
    let literal = tail.split_once('=')?.1.trim_start();
    let mut escaped = false;
    let end = literal.char_indices().skip(1).find_map(|(i, c)| {
        if escaped { escaped = false; None } else if c == '\\' { escaped = true; None } else if c == '"' { Some(i + 1) } else { None }
    })?;
    serde_json::from_str(&literal[..end]).ok()
}

fn fetch_path(base_url: &str, path: &str) -> Result<String, ()> {
    let authority = base_url.strip_prefix("http://").ok_or(())?.trim_end_matches('/');
    if authority.contains('/') { return Err(()); }
    let mut stream = authority.to_socket_addrs().map_err(|_| ())?.find(|a| a.ip().is_loopback()).and_then(|a| TcpStream::connect_timeout(&a, Duration::from_secs(2)).ok()).ok_or(())?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).map_err(|_| ())?;
    // 🔴 **整个请求一次写出去，不要用 `write!`。** `write_fmt` 会把格式串拆成好几段，
    // 每段一次 `write` 系统调用（这里是 5 段）。服务端只要在中间那几段之前就把响应写完并
    // 关掉连接，剩下几段就写在一个已关闭的 socket 上 —— Windows 回的是
    // WSAECONNABORTED(10053) / WSAECONNRESET(10054)，表现是「刚连上、请求还没发完，对端没了」。
    //
    // 这正是 `hermes_status_accepts_only_a_real_hermes_probe` 在 Windows 上约 40% 变红的成因
    // （见 WINDOWS-PORT.md WP2，此前记的是「根因未定位」）。POSIX 上同样的拆分很少出事，
    // 因为小请求通常一段就走完、服务端那一次 read 也就拿全了。
    let request = format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|_| ())?;
    let mut response = String::new(); stream.read_to_string(&mut response).map_err(|_| ())?;
    let (headers, body) = response.split_once("\r\n\r\n").ok_or(())?;
    if !headers.lines().next().is_some_and(|line| line.contains(" 200 ")) { return Err(()); }
    Ok(body.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{extract_session_token, hermes_status, newest_first, marks_source, normalize_semantic_state, read_state_file, sources_to_search, state_file_name};
    #[cfg(target_os = "macos")]
    use super::parse_listening_ports;
    use std::{env, fs, io::{Read, Write}, net::TcpListener, process, thread, time::{SystemTime, UNIX_EPOCH}};

    /// 起一个只回一次的极简 HTTP 服务，用来验证握手。返回 base_url。
    fn serve_once(body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 1024];
            // 🔴 **把请求头读干净再回应。** 只 read 一次的话，客户端剩下的字节还在路上，
            // 而我们已经回应并关闭 —— 带着未读数据关闭，内核发的是 RST。客户端那边
            // 表现为写失败（Windows 上 10053/10054）。真实服务端都是读完头再回应的。
            let mut seen = Vec::new();
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        seen.extend_from_slice(&buffer[..count]);
                        if seen.windows(4).any(|window| window == b"\r\n\r\n") { break; }
                    }
                    Err(_) => break,
                }
            }
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            // 必须先冲刷 + 半关闭 + 把客户端剩余请求读干净再放手：带着未读数据关闭 socket，
            // 内核发的是 RST 而不是 FIN，客户端会收到 ConnectionReset 且响应被截断（这条测试
            // 曾因此约 75% 概率假失败）。真实服务端会读完请求再优雅关闭。
            let _ = stream.flush();
            let _ = stream.shutdown(std::net::Shutdown::Write);
            let _ = stream.read(&mut buffer);
        });
        url
    }

    #[test]
    fn normalizes_flat_state_and_rejects_star_office_schema() {
        // 自带 hook 的扁平快照
        let flat = serde_json::json!({ "state": "working", "sequence": 3, "detail": "x" });
        assert_eq!(normalize_semantic_state(&flat).unwrap(), serde_json::json!({ "state": "working", "sequence": 3, "token": null, "reaction": null, "doing": null }));
        // 详情那一行：有就透传，长度在这里再兜一道（上游已截到 40 字符）
        let doing = serde_json::json!({ "state": "executing", "sequence": 5, "doing": "Run the test suite" });
        assert_eq!(normalize_semantic_state(&doing).unwrap()["doing"], serde_json::json!("Run the test suite"));
        let long = serde_json::json!({ "state": "executing", "sequence": 5, "doing": "x".repeat(300) });
        assert_eq!(normalize_semantic_state(&long).unwrap()["doing"].as_str().unwrap().chars().count(), 80);
        // 不是字符串的当作没有 —— 快照被手改过时不该把一个对象贴到状态栏上
        let bogus = serde_json::json!({ "state": "executing", "sequence": 5, "doing": { "text": "x" } });
        assert_eq!(normalize_semantic_state(&bogus).unwrap()["doing"], serde_json::Value::Null);
        // reaction 透传：合法形状（kind+sequence）带出，缺省/非法为 null（叠加层，不影响基态）
        let with_reaction = serde_json::json!({ "state": "writing", "sequence": 4, "reaction": { "kind": "blocked", "sequence": 2 } });
        assert_eq!(normalize_semantic_state(&with_reaction).unwrap()["reaction"], serde_json::json!({ "kind": "blocked", "sequence": 2, "at": 0.0 }));
        // `at` 是前端去重键，必须原样透传（sequence 会随 .sessions 重建复位，不能当门）
        let dated = serde_json::json!({ "state": "idle", "sequence": 1, "reaction": { "kind": "interrupted", "sequence": 1, "at": 1787867628.5 } });
        assert_eq!(normalize_semantic_state(&dated).unwrap()["reaction"]["at"], 1787867628.5);
        // M1 解耦后 Star Office 的嵌套 schema 不再兼容 —— 必须当作「没有」，否则前端会静默恒 idle
        let nested = serde_json::json!({ "sequence": 78, "desired": { "update": { "state": "executing" } } });
        assert!(normalize_semantic_state(&nested).is_none());
        let pushed = serde_json::json!({ "sequence": 9, "last_push": { "state": "error" } });
        assert!(normalize_semantic_state(&pushed).is_none());
        // 取不出 state 的必须当作「没有」
        assert!(normalize_semantic_state(&serde_json::json!({ "sequence": 1 })).is_none());
        assert!(normalize_semantic_state(&serde_json::json!({ "state": 5 })).is_none());
        // hook 带出来的 token 要透给前端；没有时是 null 而不是缺字段
        let with_token = serde_json::json!({ "state": "idle", "sequence": 1, "audio": { "token": "tok" } });
        assert_eq!(normalize_semantic_state(&with_token).unwrap()["token"], "tok");
        assert!(normalize_semantic_state(&flat).unwrap()["token"].is_null());
    }

    #[test]
    fn a_stale_busy_snapshot_falls_back_to_idle() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = env::temp_dir().join(format!("agent-avatar-stale-{}-{nonce}.json", process::id()));
        fs::write(&path, r#"{"state":"executing","sequence":7}"#).unwrap();
        assert_eq!(read_state_file(&path).unwrap()["state"], "executing");
        // 会话被杀 / 收尾事件没跑到时，忙态会永远留在文件里，皮肤就卡在那个表情
        let handle = fs::File::options().write(true).open(&path).unwrap();
        let long_ago = SystemTime::now() - std::time::Duration::from_secs(600);
        handle.set_times(fs::FileTimes::new().set_modified(long_ago)).unwrap();
        assert_eq!(read_state_file(&path).unwrap()["state"], "idle");
        // idle 本来就是静止态，放多久都不该被改写
        fs::write(&path, r#"{"state":"idle","sequence":8}"#).unwrap();
        let handle = fs::File::options().write(true).open(&path).unwrap();
        handle.set_times(fs::FileTimes::new().set_modified(long_ago)).unwrap();
        assert_eq!(read_state_file(&path).unwrap()["state"], "idle");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn candidate_state_files_are_ordered_by_freshness() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = env::temp_dir().join(format!("agent-avatar-freshness-{}-{nonce}", process::id()));
        fs::create_dir_all(&dir).unwrap();
        let (stale, live) = (dir.join("stale.json"), dir.join("live.json"));
        fs::write(&stale, "{}").unwrap();
        thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&live, "{}").unwrap();
        // stale 排在前面也不该赢 —— 只写过一次的旧文件盖住正在更新的那个，就是「状态卡住」的成因
        assert_eq!(newest_first(vec![stale.clone(), live.clone()]), vec![live.clone(), stale.clone()]);
        // 不存在的候选直接出局，不占位
        assert_eq!(newest_first(vec![dir.join("missing.json"), stale.clone()]), vec![stale]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn listening_ports_come_from_the_address_column_not_the_user_name() {
        // 按真实 lsof 输出的形状构造（地址已换成文档保留段 RFC 5737，不带任何本机信息）：
        // USER 列恰好就是 `hermes`，所以按行 contains("hermes") 会全中 —— 这正是本用例要挡的回归。
        let output = "COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\nollama      101 hermes    3u  IPv4 0x0000000000000001      0t0  TCP 127.0.0.1:11434 (LISTEN)\nrapportd    102 hermes   10u  IPv4 0x0000000000000002      0t0  TCP *:49152 (LISTEN)\npython3.1   103 hermes    3u  IPv4 0x0000000000000003      0t0  TCP 127.0.0.1:19000 (LISTEN)\nremoteapp   104 hermes   71u  IPv4 0x0000000000000004      0t0  TCP 192.0.2.10:61684 (LISTEN)\n";
        // 非回环地址不进候选；端口去重排序
        assert_eq!(parse_listening_ports(output), vec![11434, 19000, 49152]);
        assert!(parse_listening_ports("COMMAND\n").is_empty());
    }

    /// 🔴 **这条曾经在 Windows 上约 40% 变红，一度被 ignore 掉。** 根因不在测试里：
    /// `fetch_path` 用 `write!` 发请求，而 `write_fmt` 把格式串拆成 5 次 `write` 系统调用；
    /// 服务端只 read 一次就回应并关闭，客户端剩下几段便写在已关闭的 socket 上，
    /// Windows 回 WSAECONNABORTED(10053) / WSAECONNRESET(10054)。
    /// 两边都改了：客户端整包一次写出，服务端读完请求头再回应。
    #[test]
    //
    fn hermes_status_accepts_only_a_real_hermes_probe() {
        let hermes = serve_once(r#"{"version":"1.0","config_version":3,"gateway_running":true,"auth_required":false}"#);
        assert_eq!(hermes_status(&hermes).unwrap()["auth_required"], false);
        // 本机其它服务（这里模拟 ollama 的根响应）不能被认成 Hermes
        let other = serve_once(r#"{"models":[]}"#);
        assert!(hermes_status(&other).is_none());
    }

    #[test]
    fn extracts_and_unescapes_injected_session_token() {
        let html = r#"<script>window.__HERMES_SESSION_TOKEN__ = "abc\"\\def";</script>"#;
        assert_eq!(extract_session_token(html).as_deref(), Some("abc\"\\def"));
        assert_eq!(extract_session_token("<html></html>"), None);
    }

    /// 文件名规则必须与 Python 侧 `core/state_machine.py: state_path()` 一字不差 ——
    /// 两边对不上的表现是「一直 idle」，不报错，最难查。
    #[test]
    fn state_file_names_match_the_python_side() {
        assert_eq!(state_file_name("hermes"), "agent-avatar-state.json");
        assert_eq!(state_file_name("claude-code"), "agent-avatar-state.claude-code.json");
        assert_eq!(state_file_name("codex"), "agent-avatar-state.codex.json");
        assert_eq!(state_file_name("workbuddy"), "agent-avatar-state.workbuddy.json");
        assert_eq!(state_file_name("dsh"), "agent-avatar-state.dsh.json");
    }

    #[test]
    fn state_source_off_reads_nothing() {
        assert_eq!(sources_to_search(Some("off")), None);
    }

    /// 「自动」下要标出这一条状态是谁写的；钉死某一家时**不标**。
    ///
    /// 判据放在 `marks_source` 而不是界面层：那一层已经有语言、手动动作、点击穿透提示
    /// 四样东西在拼同一行，再塞一个「现在是不是自动模式」的条件进去，下次改的人必然漏掉一个。
    #[test]
    fn only_auto_marks_which_harness_the_state_came_from() {
        assert!(marks_source(None), "没给来源 = 自动");
        assert!(marks_source(Some("auto")));
        for pinned in ["hermes", "claude-code", "codex", "workbuddy", "dsh"] {
            assert!(!marks_source(Some(pinned)), "钉死 {pinned} 时不该标来源");
        }
        // 「关闭」根本读不到状态，标不标都无所谓，但也不该标
        assert!(!marks_source(Some("off")));
    }

    #[test]
    fn a_named_harness_is_read_alone() {
        assert_eq!(sources_to_search(Some("codex")), Some(vec!["codex"]));
        assert_eq!(sources_to_search(Some("hermes")), Some(vec!["hermes"]));
    }

    /// 未设置 / "auto" / 任何不认识的值都退回「查全部，按 mtime 取最新」。
    /// 关键是**不认识的值绝不能被拼进文件名** —— 返回的永远是白名单里的 &'static str。
    #[test]
    fn unknown_sources_fall_back_to_auto_and_never_reach_the_path() {
        let all = Some(vec!["hermes", "claude-code", "codex", "workbuddy", "dsh"]);
        assert_eq!(sources_to_search(None), all);
        assert_eq!(sources_to_search(Some("auto")), all);
        assert_eq!(sources_to_search(Some("../../etc/passwd")), all);
        assert_eq!(sources_to_search(Some("")), all);
    }
}
