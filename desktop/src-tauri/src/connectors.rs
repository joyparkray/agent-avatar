//! Agent connector（各家 harness 的插件）一键接入。
//!
//! **为什么在 app 里跑外部命令而不是让用户开终端**：接入 connector 原来的路子是
//! 「去 Release 下 connectors.zip → 解压 → 在终端里跑 install-plugin.sh」。
//! 这三步里每一步都能把非开发者用户挡在门外，而它们全都是机械动作 —— 应用自己做得了。
//!
//! **为什么下载/解压用 `curl` / `unzip` 而不是引 crate**：两者都是 macOS 自带
//! （`/usr/bin/curl`、`/usr/bin/unzip`），而引 reqwest + zip 会给一个 5MB 的桌宠
//! 拖进上百个传递依赖。应用本来就已经在用 `Command`（见 config.rs 的 `open`）。
//!
//! **为什么必须整棵树解压**：`connectors/<harness>/install-plugin.sh` 内部用相对路径引
//! `../assemble.sh` 与 `../../bridge/state_machine.py`。拆散目录 = 装完的插件缺 core，
//! 而那种失败是静默的（hook 起不来，形象一直 idle）。所以 staging 目录里必须同时有
//! `connectors/` 和 `bridge/` 两棵，且保持相对位置。
//!
//! 本模块**不改 connector 的安装脚本**：脚本是五家共用的单一真相，app 只是替用户按下回车。
use crate::user_error;
use serde_json::{json, Value};
use std::{env, fs, path::{Path, PathBuf}, process::Command};
use tauri::Emitter;

/// 认得的 harness。**这是白名单**：名字会被拼进路径与命令行，不能让任意字符串进来。
pub const HARNESSES: [&str; 5] = ["claude-code", "codex", "dsh", "hermes", "workbuddy"];

/// 正式发布地址。`latest/download` 是 GitHub 的稳定别名，不需要在 app 里写死版本号。
const RELEASE_URL: &str =
    "https://github.com/joyparkray/agent-avatar/releases/latest/download/agent-avatar-connectors.zip";

/// 本地联调用的覆盖项：指向一个已经构建好的 zip，跳过下载这一步。
/// 仓库还没发布 Release 时（或想验证未发布的改动）用它。
const LOCAL_ZIP_ENV: &str = "AGENT_AVATAR_CONNECTORS_ZIP";

/// 从 Finder 启动的 app 只继承一份最小 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），
/// 而安装脚本要调 `python3`、`node`、`codex`、`codebuddy` —— 后三个几乎都装在
/// Homebrew / 用户目录下。不补这一段的话，用户从终端跑成功、从 app 里跑失败，
/// 而错误信息只是「command not found」，完全指不到真正的原因。
fn command_path() -> String {
    let inherited = env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".to_owned());
    let home = env::var("HOME").unwrap_or_default();
    let extra = ["/opt/homebrew/bin", "/usr/local/bin", &format!("{home}/.local/bin"), &format!("{home}/bin")]
        .join(":");
    format!("{extra}:{inherited}")
}

fn home() -> PathBuf {
    env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}

/// `$VAR`，没设就用 `$HOME/<fallback>`。各家 install-plugin.sh 里的口径，原样照搬。
fn harness_home(var: &str, fallback: &str) -> PathBuf {
    env::var(var).ok().filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(fallback))
}

/// 装完之后插件落在哪。判断「已装/未装」与卸载都看这个目录。
/// 路径来自各家 `install-plugin.sh` 里的 `target=`，改脚本时这里要跟着改。
pub fn plugin_dir(harness: &str) -> Option<PathBuf> {
    Some(match harness {
        "claude-code" => harness_home("CLAUDE_CONFIG_DIR", ".claude").join("plugins/local/agent-avatar"),
        "codex" => harness_home("CODEX_HOME", ".codex").join("plugins/agent-avatar"),
        "dsh" => harness_home("DSH_HOME", ".dsh").join("plugins/agent-avatar"),
        "hermes" => harness_home("HERMES_HOME", ".hermes").join("plugins/agent-avatar"),
        // WorkBuddy 装的是「本地 marketplace」，插件树在 marketplace 目录下面
        "workbuddy" => harness_home("WORKBUDDY_HOME", ".workbuddy")
            .join("local-marketplaces/agent-avatar-local/plugins/agent-avatar"),
        _ => return None,
    })
}

/// 五家的接入状态。前端首次引导页与设置页共用这一条。
///
/// 两条信息**必须分开**：`installed` 只说明文件装了，`lastSignalSeconds` 才说明链路真的通了。
/// 只报前者的话，「装完了但没 enable / 没授信 / 没重启」会显示成一切正常，
/// 而那正是用户最容易卡住的地方（装好了、形象却一直不动，没有任何线索）。
#[tauri::command(async)]
pub fn list_connectors() -> Vec<Value> {
    HARNESSES.iter().map(|harness| {
        let dir = plugin_dir(harness);
        json!({
            "harness": harness,
            "installed": dir.as_deref().is_some_and(Path::is_dir),
            "path": dir.map(|path| path.display().to_string()),
            // 用「有没有写过」而不是「最近有没有写过」当门：一周没用那家 agent 的用户
            // 不该被告知需要重新配置。新旧程度另外显示，由前端决定怎么说。
            "lastSignalSeconds": crate::hermes::last_signal_seconds(harness),
        })
    }).collect()
}

/// 下载/解压/执行三段各报一次。静默失败最难查 —— 用户只会看到「点了没反应」。
fn progress(app: &tauri::AppHandle, harness: &str, stage: &str) {
    let _ = app.emit("connector-progress", json!({ "harness": harness, "stage": stage }));
}

/// 外部命令的回显。stdout/stderr 都要 —— 安装脚本的后续步骤提示走 stdout，失败原因走 stderr。
fn run(program: &str, args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args).env("PATH", command_path());
    if let Some(dir) = cwd { command.current_dir(dir); }
    let output = command.output().map_err(|error| format!("{program}: {error}"))?;
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    if output.status.success() { Ok(text) } else { Err(tail(&text, 2000)) }
}

/// 只把回显的末尾交给界面：安装脚本可能刷很多行，而有用的（失败原因/后续步骤）在最后。
fn tail(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= max { return trimmed.to_owned(); }
    let start = trimmed.len() - max;
    // 不能从多字节字符中间切，否则中文回显会被切成乱码
    let start = (start..trimmed.len()).find(|index| trimmed.is_char_boundary(*index)).unwrap_or(trimmed.len());
    format!("…\n{}", &trimmed[start..])
}

/// 把 zip 弄到 staging 目录。`local` 有值时直接拷（本地联调），否则从 Release 下。
fn fetch_zip(target: &Path, local: Option<&Path>) -> Result<(), String> {
    if let Some(source) = local {
        if !source.is_file() { return Err(format!("{}|{}", user_error::LOCAL_ZIP_MISSING, source.display())); }
        fs::copy(source, target).map_err(|error| error.to_string())?;
        return Ok(());
    }
    // `--proto =https`：只允许 https，连重定向也不许降级到别的协议。
    //
    // **超时是必须的**：curl 默认没有总时限。断网 / 连上了但不发数据时它会一直挂着，
    // 而界面上表现为「正在下载…」永远不结束、那一行的按钮永远是灰的 ——
    // 用户既得不到错误也没法重试，只能重启应用。zip 只有 93KB，宁可早点报错让他再点一次。
    run("/usr/bin/curl", &["-fsSL", "--proto", "=https", "--proto-redir", "=https",
                           "--connect-timeout", "15", "--max-time", "120",
                           "-o", &target.display().to_string(), RELEASE_URL], None)
        .map(|_| ())
        .map_err(|error| format!("{}|{error}", user_error::DOWNLOAD_FAILED))
}

/// 取回并解压整棵树，返回这家的 install-plugin.sh 路径。
///
/// **两棵树必须同时在、且保持相对位置**：install-plugin.sh 内部引 `../assemble.sh` 与
/// `../../bridge/state_machine.py`。缺 core 时装出来的插件是坏的，而那种坏是静默的
/// （hook 起不来，形象一直 idle），所以这里先验结构再交给脚本。
/// `stage` 在每一段开始时回调 —— 进度必须在**做之前**报，做完再报等于全程只闪一下。
fn prepare_staging(staging: &Path, harness: &str, local: Option<&Path>, stage: &dyn Fn(&str)) -> Result<PathBuf, String> {
    let zip = staging.join("agent-avatar-connectors.zip");
    stage("download");
    fetch_zip(&zip, local)?;
    stage("extract");
    // 先清掉上一次解压的两棵树：`unzip -o` 只覆盖同名文件，被删掉的文件会留成幽灵。
    for stale in ["connectors", "bridge"] { let _ = fs::remove_dir_all(staging.join(stale)); }
    run("/usr/bin/unzip", &["-q", "-o", &zip.display().to_string(), "-d", &staging.display().to_string()], None)
        .map_err(|error| format!("{}|{error}", user_error::EXTRACT_FAILED))?;
    let script = staging.join("connectors").join(harness).join("install-plugin.sh");
    if !script.is_file() || !staging.join("bridge/state_machine.py").is_file() {
        return Err(user_error::BAD_ARCHIVE.to_owned());
    }
    Ok(script)
}

/// staging 根目录。放在 app 数据目录下，与模型同级 —— 不写 .app 自身（签名会失效）。
fn staging_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = crate::config::data_dir(app)?.join("connectors-staging");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

/// 一键接入：下载 → 解压 → 跑这家的 install-plugin.sh。
///
/// 返回安装脚本的回显 —— 各家脚本末尾都印了「接着做什么」，那正是用户需要看到的东西。
#[tauri::command(async)]
pub fn install_connector(app: tauri::AppHandle, harness: String) -> Result<Value, String> {
    if !HARNESSES.contains(&harness.as_str()) { return Err(format!("{}|{harness}", user_error::UNKNOWN_HARNESS)); }
    let staging = staging_dir(&app)?;
    let local = env::var(LOCAL_ZIP_ENV).ok().filter(|value| !value.is_empty()).map(PathBuf::from);

    let script = prepare_staging(&staging, &harness, local.as_deref(), &|stage| progress(&app, &harness, stage))?;

    progress(&app, &harness, "install");
    let log = run("/bin/sh", &[&script.display().to_string()], Some(&staging))
        .map_err(|error| format!("{}|{error}", user_error::INSTALL_FAILED))?;
    Ok(json!({ "harness": harness, "log": tail(&log, 2000) }))
}

/// dsh 的 patch 文件里由安装脚本托管的那一段。卸载要连它一起摘掉 ——
/// 只删插件目录的话，patch 里还留着一条指向已删目录的 entry，dsh 下次加载会报错。
const DSH_BEGIN: &str = "# >>> agent-avatar (managed) >>>";
const DSH_END: &str = "# <<< agent-avatar (managed) <<<";

/// 按行摘掉托管块，其余原样保留。**不用 YAML 解析器**：dsh 的 patch 允许 `!!js` 表达式，
/// 通用解析器读它会丢行甚至报错（安装脚本里同一条注意事项）。
fn strip_managed_block(text: &str) -> String {
    let mut out = Vec::new();
    let mut skipping = false;
    for line in text.lines() {
        match line.trim() {
            DSH_BEGIN => { skipping = true; continue; }
            DSH_END => { skipping = false; continue; }
            _ => {}
        }
        if !skipping { out.push(line); }
    }
    let body = out.join("\n");
    let body = body.trim_end();
    if body.is_empty() { String::new() } else { format!("{body}\n") }
}

/// 从 Codex 的 marketplace.json 里摘掉 agent-avatar 那条，保留用户其它条目。
/// 读不动就返回 None（不去猜坏文件的内容，也不覆盖它）。
fn without_marketplace_entry(raw: &str) -> Option<String> {
    let mut doc: Value = serde_json::from_str(raw).ok()?;
    let plugins = doc.get_mut("plugins")?.as_array_mut()?;
    plugins.retain(|entry| entry.get("name").and_then(Value::as_str) != Some("agent-avatar"));
    serde_json::to_string_pretty(&doc).ok()
}

/// 卸载。**先跑各家自己的注销命令**（有 CLI 的话），再删目录、清注册项。
///
/// 注销命令失败不算错误：CLI 可能没装、或本来就没注册过，而残留的目录/注册项才是
/// 用户看得见的问题。删干净比报错更有用。
#[tauri::command(async)]
pub fn uninstall_connector(harness: String) -> Result<Value, String> {
    let dir = plugin_dir(&harness).ok_or_else(|| format!("{}|{harness}", user_error::UNKNOWN_HARNESS))?;
    let mut notes: Vec<String> = Vec::new();
    match harness.as_str() {
        "codex" => {
            if let Err(error) = run("/usr/bin/env", &["codex", "plugin", "remove", "agent-avatar"], None) {
                notes.push(format!("codex plugin remove: {}", tail(&error, 200)));
            }
            let marketplace = harness_home("AGENTS_HOME", ".agents").join("plugins/marketplace.json");
            if let Ok(raw) = fs::read_to_string(&marketplace) {
                match without_marketplace_entry(&raw) {
                    Some(cleaned) => { let _ = fs::write(&marketplace, cleaned); }
                    None => notes.push(format!("marketplace.json 读不动，未改动：{}", marketplace.display())),
                }
            }
        }
        "dsh" => {
            let patch = harness_home("DSH_HOME", ".dsh").join("cordis.patch.yml");
            if let Ok(raw) = fs::read_to_string(&patch) {
                let _ = fs::write(&patch, strip_managed_block(&raw));
            }
        }
        "workbuddy" => {
            let cli = env::var("CODEBUDDY_CLI").unwrap_or_else(|_|
                "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy".to_owned());
            if Path::new(&cli).is_file() {
                if let Err(error) = run(&cli, &["plugin", "uninstall", "agent-avatar"], None) {
                    notes.push(format!("codebuddy plugin uninstall: {}", tail(&error, 200)));
                }
            }
            // 删的是整个本地 marketplace 目录（插件树在它下面两层）
            let market = harness_home("WORKBUDDY_HOME", ".workbuddy").join("local-marketplaces/agent-avatar-local");
            if market.is_dir() { fs::remove_dir_all(&market).map_err(|error| error.to_string())?; }
        }
        _ => {}
    }
    if dir.is_dir() { fs::remove_dir_all(&dir).map_err(|error| error.to_string())?; }
    Ok(json!({ "harness": harness, "notes": notes }))
}

#[cfg(test)]
mod tests {
    use super::{command_path, plugin_dir, prepare_staging, strip_managed_block, tail, without_marketplace_entry, HARNESSES};
    use std::{fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

    fn scratch(tag: &str) -> PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("agent-avatar-{tag}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn every_harness_resolves_to_a_plugin_directory() {
        for harness in HARNESSES {
            let dir = plugin_dir(harness).unwrap_or_else(|| panic!("{harness}"));
            assert!(dir.ends_with("agent-avatar"), "{harness}: {}", dir.display());
        }
        assert!(plugin_dir("../etc").is_none());
        assert!(plugin_dir("").is_none());
    }

    #[test]
    fn plugin_paths_match_the_install_scripts() {
        // 判据来自各家 install-plugin.sh 的 `target=`。脚本改了这里必须跟着改，
        // 否则表现是「装完了界面还说没装」。
        let claude = plugin_dir("claude-code").unwrap();
        assert!(claude.ends_with(".claude/plugins/local/agent-avatar") || claude.ends_with("plugins/local/agent-avatar"));
        assert!(plugin_dir("workbuddy").unwrap().ends_with("local-marketplaces/agent-avatar-local/plugins/agent-avatar"));
        assert!(plugin_dir("hermes").unwrap().ends_with("plugins/agent-avatar"));
    }

    #[test]
    fn strips_only_the_managed_block_from_the_dsh_patch() {
        let patch = "- insert:\n    - id: mine\n      name: /x/y.mjs\n\
                     # >>> agent-avatar (managed) >>>\n- insert:\n    - id: agent-avatar\n      name: /p/index.mjs\n\
                     # <<< agent-avatar (managed) <<<\n";
        let cleaned = strip_managed_block(patch);
        assert!(cleaned.contains("id: mine"), "用户自己的条目必须留着：{cleaned}");
        assert!(!cleaned.contains("agent-avatar"));
        assert!(cleaned.ends_with('\n'));
        // 只有托管块时应当留下空文件，而不是一个只剩空行的非法 YAML
        assert_eq!(strip_managed_block("# >>> agent-avatar (managed) >>>\n- insert: []\n# <<< agent-avatar (managed) <<<\n"), "");
        // 没装过时原样返回
        assert_eq!(strip_managed_block("- insert:\n    - id: mine\n"), "- insert:\n    - id: mine\n");
    }

    #[test]
    fn removes_only_our_entry_from_the_codex_marketplace() {
        let raw = r#"{"name":"local","plugins":[{"name":"other"},{"name":"agent-avatar"}]}"#;
        let cleaned = without_marketplace_entry(raw).unwrap();
        assert!(cleaned.contains("other"));
        assert!(!cleaned.contains("agent-avatar"));
        // 坏文件不去猜它的内容，也就不会被覆盖
        assert!(without_marketplace_entry("not json").is_none());
        assert!(without_marketplace_entry(r#"{"plugins":"nope"}"#).is_none());
    }

    #[test]
    fn command_path_adds_the_usual_install_locations() {
        // 从 Finder 启动只继承最小 PATH，脚本要的 node/codex/codebuddy 都不在里面。
        let path = command_path();
        assert!(path.contains("/opt/homebrew/bin"));
        assert!(path.contains("/usr/local/bin"));
        assert!(path.contains("/usr/bin"));
    }

    #[test]
    fn staging_keeps_connectors_and_bridge_together() {
        // install-plugin.sh 靠相对路径找 ../assemble.sh 与 ../../bridge/ —— 拆散就装出坏插件，
        // 而那种坏是静默的（hook 起不来，形象一直 idle）。
        let zip = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../release/agent-avatar-connectors.zip");
        if !zip.is_file() {
            println!("跳过：没有本地 release zip（{}），请先跑发布脚本", zip.display());
            return;
        }
        let dir = scratch("staging");
        let script = prepare_staging(&dir, "claude-code", Some(&zip), &|_| {}).unwrap();
        assert!(script.is_file(), "{}", script.display());
        assert!(dir.join("bridge/state_machine.py").is_file(), "core 必须和 connectors/ 一起解出来");
        assert!(dir.join("connectors/assemble.sh").is_file(), "五家共用的组装脚本也必须在");
        // 重复安装是常见操作（重装按钮），不能因为目录已存在就失败
        prepare_staging(&dir, "hermes", Some(&zip), &|_| {}).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn staging_reports_a_missing_local_zip_instead_of_installing_nothing() {
        let dir = scratch("staging-missing");
        let error = prepare_staging(&dir, "hermes", Some(Path::new("/nonexistent.zip")), &|_| {}).unwrap_err();
        // 代号 + 细节：措辞在前端（见 lib.rs 的 user_error）
        assert!(error.starts_with(&format!("{}|", crate::user_error::LOCAL_ZIP_MISSING)), "{error}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tail_keeps_the_end_and_never_splits_a_character() {
        assert_eq!(tail("  short  ", 100), "short");
        let long = "中".repeat(1000);
        let cut = tail(&long, 100);
        assert!(cut.starts_with("…\n"));
        assert!(cut.chars().all(|c| c == '中' || c == '…' || c == '\n'));
        assert!(cut.len() <= 106);
    }
}
