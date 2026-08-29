//! Hermes 适配层 —— **可整体摘除的边界**（M1 §1.2）。
//!
//! 删掉本文件与 `lib.rs` 里的 `mod hermes;` / 两个 handler 注册后，应用仍然完整可用：
//! 前端 `invoke` 调不到命令会走 `SemanticDriver` 的失败降级（常驻 idle），
//! 文件 / 全局音源与形象动作完全不受影响。配套的 hook 见 `integrations/hermes/`。
use serde_json::Value;
use std::{env, fs, io::{Read, Write}, net::{TcpStream, ToSocketAddrs}, path::{Path, PathBuf}, process::Command, time::{Duration, SystemTime}};

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
    Some(serde_json::json!({ "state": state, "sequence": sequence, "token": token, "reaction": reaction }))
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

fn candidate_paths(harness: &str) -> Vec<PathBuf> {
    let name = state_file_name(harness);
    let mut paths = vec![];
    if let Ok(dir) = env::var("TMPDIR") { paths.push(PathBuf::from(&dir).join(&name)); }
    paths.push(PathBuf::from("/tmp").join(&name));
    paths
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
    let paths = harnesses.iter().flat_map(|h| candidate_paths(h)).collect();
    newest_first(paths).into_iter().find_map(|path| read_state_file(&path))
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
fn parse_listening_ports(lsof_output: &str) -> Vec<u16> {
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
            let output = Command::new("lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN"]).output().ok()?;
            parse_listening_ports(&String::from_utf8_lossy(&output.stdout)).into_iter()
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
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n").map_err(|_| ())?;
    let mut response = String::new(); stream.read_to_string(&mut response).map_err(|_| ())?;
    let (headers, body) = response.split_once("\r\n\r\n").ok_or(())?;
    if !headers.lines().next().is_some_and(|line| line.contains(" 200 ")) { return Err(()); }
    Ok(body.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{extract_session_token, hermes_status, newest_first, normalize_semantic_state, parse_listening_ports, read_state_file, sources_to_search, state_file_name};
    use std::{env, fs, io::{Read, Write}, net::TcpListener, process, thread, time::{SystemTime, UNIX_EPOCH}};

    /// 起一个只回一次的极简 HTTP 服务，用来验证握手。返回 base_url。
    fn serve_once(body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer);
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
        assert_eq!(normalize_semantic_state(&flat).unwrap(), serde_json::json!({ "state": "working", "sequence": 3, "token": null, "reaction": null }));
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
    fn listening_ports_come_from_the_address_column_not_the_user_name() {
        // 按真实 lsof 输出的形状构造（地址已换成文档保留段 RFC 5737，不带任何本机信息）：
        // USER 列恰好就是 `hermes`，所以按行 contains("hermes") 会全中 —— 这正是本用例要挡的回归。
        let output = "COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\nollama      101 hermes    3u  IPv4 0x0000000000000001      0t0  TCP 127.0.0.1:11434 (LISTEN)\nrapportd    102 hermes   10u  IPv4 0x0000000000000002      0t0  TCP *:49152 (LISTEN)\npython3.1   103 hermes    3u  IPv4 0x0000000000000003      0t0  TCP 127.0.0.1:19000 (LISTEN)\nremoteapp   104 hermes   71u  IPv4 0x0000000000000004      0t0  TCP 192.0.2.10:61684 (LISTEN)\n";
        // 非回环地址不进候选；端口去重排序
        assert_eq!(parse_listening_ports(output), vec![11434, 19000, 49152]);
        assert!(parse_listening_ports("COMMAND\n").is_empty());
    }

    #[test]
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
