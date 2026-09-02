//! Agent connector（各家 harness 的插件）的**检测与诊断**。
//!
//! 🔴 **这个模块不装任何东西。** 定案（见 private/RELEASE-CONNECTOR-WIZARD-DESIGN.md
//! 「已定方案」）之后，装 connector 这件事交给用户的 agent 做 ——
//! 用户本来就坐在一个能执行命令的 agent 面前，而那条路比 app 自己装干净得多：
//!
//! - **没有下载**：harness 用自己的插件渠道去 clone，不经过我们。
//!   app 下载的文件在 Windows 上会被打上 Mark of the Web，然后「未签名脚本改配置」
//!   会被行为分析盯上 —— 实机撞到过：卡巴斯基把我们的安装脚本判成
//!   `PDM:Trojan.Win32.Generic` 并**直接删除**。
//! - **没有解压、没有执行脚本**：那两步一起消失了。
//! - **agent 能做 app 做不了的事**：缺 Python 时它可以（在用户点头后）装一个，
//!   看得懂报错，还能重试。
//!
//! 于是这里只剩两件事，也正是 app 唯一做得比 agent 好的两件事：
//!
//! 1. **检测**——插件装没装（`plugin_dirs`），以及**有没有真的上报过**
//!    （`hermes::last_signal_seconds`）。这两件事必须分开：目录在只说明文件拷过去了，
//!    没 enable / 没授信 / 没重启时目录照样在，而用户看到的是「装好了但形象一直不动」。
//! 2. **卸载**——删目录、清各家的注册项。这一步没有下载，也就没有上面那些问题。
//!
//! 提示词（装 / 排查）在前端 `src/connector-diagnosis.ts`。
use crate::user_error;
use serde_json::{json, Value};
use std::{env, fs, path::{Path, PathBuf}, process::Command};

/// 认得的 harness。**这是白名单**：名字会被拼进路径与命令行，不能让任意字符串进来。
pub const HARNESSES: [&str; 5] = ["claude-code", "codex", "dsh", "hermes", "workbuddy"];

/// 卸载时要调各家的 CLI（`codex plugin remove` / `codebuddy plugin uninstall`）。
/// 从 Finder 或资源管理器启动的 app 只继承一份最小 PATH，而那几个 CLI 装在
/// Homebrew / npm 的全局 bin 下 —— 不补这一段的话，用户从终端跑成功、从 app 里跑失败，
/// 而错误信息只是「command not found」，完全指不到真正的原因。
///
/// 两个平台的分隔符和落点都不一样：POSIX 是 `:` 与 Homebrew，Windows 是 `;` 与
/// npm 的全局 bin。照搬 POSIX 那套到 Windows 上等于**没补**。
fn command_path() -> String {
    let user = home();
    let user = user.display().to_string();
    #[cfg(windows)]
    let (separator, extra) = (";", vec![
        // npm 的全局 bin —— codebuddy / dsh 都装在这儿
        format!(r"{user}\AppData\Roaming\npm"),
        format!(r"{user}\.local\bin"),
    ]);
    #[cfg(not(windows))]
    let (separator, extra) = (":", vec![
        "/opt/homebrew/bin".to_owned(), "/usr/local/bin".to_owned(),
        format!("{user}/.local/bin"), format!("{user}/bin"),
    ]);
    let fallback = if cfg!(windows) { String::new() } else { "/usr/bin:/bin:/usr/sbin:/sbin".to_owned() };
    let inherited = env::var("PATH").unwrap_or(fallback);
    format!("{}{separator}{inherited}", extra.join(separator))
}

/// 用户目录。**Windows 上没有 `HOME`** —— 那是 POSIX 与 Git Bash 的约定，
/// 从资源管理器启动的 app 进程里只有 `USERPROFILE`。只读 HOME 的话，五家的插件目录
/// 全都算到 `/` 底下去，表现是**装好了界面还说没装**（而这正是本模块要报的那个状态）。
fn home() -> PathBuf {
    for name in ["HOME", "USERPROFILE"] {
        if let Ok(value) = env::var(name) {
            if !value.is_empty() { return PathBuf::from(value); }
        }
    }
    PathBuf::from("/")
}

/// `$VAR`，没设就用 `$HOME/<fallback>`。各家 install-plugin.sh 里的口径，原样照搬。
fn harness_home(var: &str, fallback: &str) -> PathBuf {
    env::var(var).ok().filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(fallback))
}

/// 「自包含的本地 marketplace」里插件树的相对位置。三家同形（Claude Code / Codex /
/// WorkBuddy 的插件机制本来就是一套），只有清单文件名各不相同。
const LOCAL_MARKETPLACE: &str = "local-marketplaces/agent-avatar-local/plugins/agent-avatar";

/// 装完之后插件可能落在哪 —— **新旧布局都要认**，按优先级排。
///
/// 定案（见 private/RELEASE-CONNECTOR-WIZARD-DESIGN.md「已定方案」）之后，
/// claude-code 与 codex 改成了和 WorkBuddy 一样的「本地 marketplace」布局：
/// 光把文件拷进 `~/.claude/plugins/local/` 或 `~/.codex/plugins/` **根本不会被发现**
/// （2026-09-02 实测：用户重启 app 后 Plugins 页里什么都没有）。
///
/// 旧目录仍然要认：按老布局装过的机器上插件还在那儿。只认新的话，
/// 表现是「明明装着，界面说没装」—— 而这个模块的全部意义就是不让这种事发生。
fn plugin_dirs(harness: &str) -> Vec<PathBuf> {
    match harness {
        "claude-code" => {
            let root = harness_home("CLAUDE_CONFIG_DIR", ".claude");
            vec![root.join(LOCAL_MARKETPLACE), root.join("plugins/local/agent-avatar")]
        }
        "codex" => {
            let root = harness_home("CODEX_HOME", ".codex");
            vec![root.join(LOCAL_MARKETPLACE), root.join("plugins/agent-avatar")]
        }
        "workbuddy" => vec![harness_home("WORKBUDDY_HOME", ".workbuddy").join(LOCAL_MARKETPLACE)],
        // dsh 与 hermes 不走 marketplace：dsh 是 cordis patch 指过来的目录，
        // hermes 是 in-process 的 Python 包，两家的位置没变过。
        "dsh" => vec![harness_home("DSH_HOME", ".dsh").join("plugins/agent-avatar")],
        "hermes" => vec![harness_home("HERMES_HOME", ".hermes").join("plugins/agent-avatar")],
        _ => Vec::new(),
    }
}

/// 首选位置（新布局）。卸载与「装到哪」的显示用它。
pub fn plugin_dir(harness: &str) -> Option<PathBuf> {
    plugin_dirs(harness).into_iter().next()
}

/// 实际存在的那个位置。没有就是没装。
fn installed_dir(harness: &str) -> Option<PathBuf> {
    plugin_dirs(harness).into_iter().find(|dir| dir.is_dir())
}

/// 五家的接入状态。前端首次引导页与设置页共用这一条。
///
/// 两条信息**必须分开**：`installed` 只说明文件装了，`lastSignalSeconds` 才说明链路真的通了。
/// 只报前者的话，「装完了但没 enable / 没授信 / 没重启」会显示成一切正常，
/// 而那正是用户最容易卡住的地方（装好了、形象却一直不动，没有任何线索）。
#[tauri::command(async)]
pub fn list_connectors() -> Vec<Value> {
    HARNESSES.iter().map(|harness| {
        let found = installed_dir(harness);
        json!({
            "harness": harness,
            "installed": found.is_some(),
            // 装了就报实际位置，没装就报**将要**装到哪 —— 后者也是有用的信息
            // （用户拿它去看杀软的隔离区里那条路径对不对得上）
            "path": found.or_else(|| plugin_dir(harness)).map(|path| path.display().to_string()),
            // 用「有没有写过」而不是「最近有没有写过」当门：一周没用那家 agent 的用户
            // 不该被告知需要重新配置。新旧程度另外显示，由前端决定怎么说。
            "lastSignalSeconds": crate::hermes::last_signal_seconds(harness),
            // 上报的 connector 版本。Windows 上装的是本地化过的副本，收不到 harness 的
            // 自动更新 —— 这条是「该更新了」唯一能被看见的地方。
            "connectorVersion": crate::hermes::reported_connector_version(harness),
            // hook 跑起来了但出错时留下的那条记录（第 2 层诊断）。界面据此说出**具体原因**，
            // 而不是只给一串「可能是这些」。
            "diagnostic": crate::hermes::last_diagnostic(harness),
        })
    }).collect()
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
    // 新旧布局都要清：按老布局装过的机器上，只删新目录等于什么都没删
    let dirs = plugin_dirs(&harness);
    if dirs.is_empty() { return Err(format!("{}|{harness}", user_error::UNKNOWN_HARNESS)); }
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
    for dir in &dirs {
        if dir.is_dir() { fs::remove_dir_all(dir).map_err(|error| error.to_string())?; }
    }
    Ok(json!({ "harness": harness, "notes": notes }))
}

#[cfg(test)]
mod tests {
    use super::{command_path, home, plugin_dir, plugin_dirs, strip_managed_block, tail,
                without_marketplace_entry, HARNESSES, LOCAL_MARKETPLACE};
    use std::{env, fs};

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
        // 判据来自各家 install-plugin.{sh,ps1} 里的 `target=`。脚本改了这里必须跟着改，
        // 否则表现是「装完了界面还说没装」。
        for harness in ["claude-code", "codex", "workbuddy"] {
            assert!(plugin_dir(harness).unwrap().ends_with(LOCAL_MARKETPLACE), "{harness}");
        }
        assert!(plugin_dir("hermes").unwrap().ends_with("plugins/agent-avatar"));
        assert!(plugin_dir("dsh").unwrap().ends_with("plugins/agent-avatar"));
    }

    #[test]
    fn old_layouts_are_still_recognised() {
        // 按老布局装过的机器上插件还在旧目录。只认新的话，表现是「明明装着，界面说没装」。
        let claude = plugin_dirs("claude-code");
        assert_eq!(claude.len(), 2, "claude-code 应当同时认新旧两个位置");
        assert!(claude[1].ends_with("plugins/local/agent-avatar"), "{}", claude[1].display());
        let codex = plugin_dirs("codex");
        assert!(codex[1].ends_with("plugins/agent-avatar"), "{}", codex[1].display());
        assert!(plugin_dirs("../etc").is_empty());
    }

    #[test]
    fn home_falls_back_to_userprofile() {
        // Windows 上没有 HOME（那是 POSIX / Git Bash 的约定）。只读 HOME 的话，
        // 五家的插件目录全算到 `/` 底下，界面会把装好的说成没装。
        assert!(home().is_absolute() || cfg!(windows), "home() 必须给出一个像样的路径");
        #[cfg(windows)]
        assert!(env::var("USERPROFILE").is_ok_and(|value| home().to_string_lossy().contains(&value)),
                "Windows 上应当落到 USERPROFILE：{}", home().display());
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
    fn command_path_adds_where_the_harness_clis_actually_live() {
        // 卸载时要调各家的 CLI（codex / codebuddy）。从 Finder 或资源管理器启动的 app
        // 只继承一份最小 PATH，那几个都不在里面 —— 表现是「用户从终端跑成功、
        // 从 app 里跑失败」，而错误只是 command not found，指不到真正的原因。
        let path = command_path();
        #[cfg(not(windows))]
        {
            assert!(path.contains("/opt/homebrew/bin"), "{path}");
            assert!(path.contains("/usr/local/bin"), "{path}");
        }
        #[cfg(windows)]
        {
            // Windows 上 npm 的全局 bin 在 %APPDATA%\npm，那是 codebuddy / dsh 的落点
            assert!(path.to_lowercase().contains("npm"), "{path}");
            assert!(path.contains(';'), "Windows 的 PATH 用分号分隔：{path}");
        }
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
