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
//! 于是这里只剩**检测**：插件装没装（读各家自己的账本，见 `installed_by_record`），
//! 以及**有没有真的上报过**（`hermes::last_signal_seconds`）。这两件事必须分开：
//! 账本记着只说明 harness 认得它，没 enable / 没授信 / 没重启时账本照样记着，
//! 而用户看到的是「装好了但形象一直不动」。
//!
//! **卸载也不在这里。** 原来有一个 `uninstall_connector`，而它对「从远程 marketplace 装」
//! 的那套完全没用：它删的两个目录都不存在，于是删掉零个文件、报告成功，
//! 而 harness 的账本原封不动（2026-09-03 实测）。根因和安装一样 —— 装是 harness 干的，
//! 它的布局我们追不动（一天之内追丢过三次）。卸载现在也走提示词，
//! 用各家自己的 `plugin uninstall`，它最清楚东西在哪。
//!
//! 提示词（装 / 排查）在前端 `src/connector-diagnosis.ts`。
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf};

/// 认得的 harness。**这是白名单**：名字会被拼进路径与命令行，不能让任意字符串进来。
pub const HARNESSES: [&str; 5] = ["claude-code", "codex", "dsh", "hermes", "workbuddy"];

/// 用户目录。**Windows 上没有 `HOME`** —— 那是 POSIX 与 Git Bash 的约定，
/// 从资源管理器启动的 app 进程里只有 `USERPROFILE`。只读 HOME 的话，五家的插件目录
/// 全都算到 `/` 底下去，表现是**装好了界面还说没装**（而这正是本模块要报的那个状态）。
pub(crate) fn home() -> PathBuf {
    for name in ["HOME", "USERPROFILE"] {
        if let Ok(value) = env::var(name) {
            if !value.is_empty() { return PathBuf::from(value); }
        }
    }
    PathBuf::from("/")
}

/// `$VAR`，没设就用 `$HOME/<fallback>`。各家自己文档里的口径，原样照搬。
pub(crate) fn harness_home(var: &str, fallback: &str) -> PathBuf {
    env::var(var).ok().filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(fallback))
}

/// app 登记时用的**完整插件 id**，形如 `<插件名>@<marketplace 名>`。两边都叫
/// `agent-avatar`：marketplace 名来自打包树里那三份清单（`connectors/build-bundle.sh`
/// 写死的 `"name": "agent-avatar"`），装和卸用的都是这个 id。
///
/// 🔴 **检测必须认全名，不能只认 `agent-avatar@` 前缀。** 认前缀的话，
/// **别的 marketplace 里同名的那个插件也算数** —— 而那一个我们既没装、也卸不掉，
/// 于是「装没装」和「卸得掉吗」给出的是两个不同的答案。2026-09-03 在 macOS 上
/// 同时撞到两种表现，机器上留着早先按提示词装的两条登记：
///
/// - Claude Code 账本里是 `agent-avatar@agent-avatar-local` → 界面说「已安装」，
///   点卸载得到 `Plugin "agent-avatar@agent-avatar" is not installed in user scope.`
/// - Codex 账本里是 `agent-avatar@local` → 卸载**报成功**（`codex plugin remove` 对
///   没装的插件照样返回 0：`Removed plugin \`agent-avatar\` from marketplace
///   \`agent-avatar\`.`），可界面卸完还是「已安装」，因为剩下的那条仍然匹配前缀。
///
/// 收尾的 `agent-avatar@agent-avatar` 后面那个引号是判据的一部分：少了它，
/// `agent-avatar@agent-avatar-local` 会照样命中。
pub(crate) const PLUGIN_ID: &str = "agent-avatar@agent-avatar";

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
        "workbuddy" => vec![harness_home("WORKBUDDY_CONFIG_DIR", ".workbuddy").join(LOCAL_MARKETPLACE)],
        // dsh 与 hermes 不走 marketplace：dsh 是 cordis patch 指过来的目录，
        // hermes 是 in-process 的 Python 包，两家的位置没变过。
        "dsh" => vec![harness_home("DSH_HOME", ".dsh").join("plugins/agent-avatar")],
        "hermes" => hermes_homes().into_iter().map(|root| root.join("plugins/agent-avatar")).collect(),
        _ => Vec::new(),
    }
}

/// Hermes 的 home 在两个平台上**不是同一个约定**（2026-09-03 实机确认）。
///
/// POSIX 上是 `~/.hermes`，而 Windows 官方安装器把它放在 `%LOCALAPPDATA%\hermes`，
/// 并且**不设 `HERMES_HOME`**。照 POSIX 那套找的话，界面永远说「未安装」——
/// 而用户明明装好了。两个都认，Windows 优先本地约定。
pub(crate) fn hermes_homes() -> Vec<PathBuf> {
    if let Ok(explicit) = env::var("HERMES_HOME") {
        if !explicit.is_empty() { return vec![PathBuf::from(explicit)]; }
    }
    let mut roots = Vec::new();
    #[cfg(windows)]
    if let Ok(local) = env::var("LOCALAPPDATA") { roots.push(PathBuf::from(local).join("hermes")); }
    roots.push(home().join(".hermes"));
    roots
}

/// harness 账本里记的安装时间（ISO 8601）。只有 Claude Code 系的账本带这个字段。
///
/// 有它就能区分「刚装完，当然还没上报」和「装了一天还是没上报」——
/// 后者才是故障。没有就返回 None，界面退回只说「还没上报过」。
fn ledger_installed_at(harness: &str) -> Option<String> {
    let ledgers: Vec<PathBuf> = match harness {
        "claude-code" => vec![harness_home("CLAUDE_CONFIG_DIR", ".claude").join("plugins/installed_plugins.json")],
        // 两个 home 都要看，理由同 `installed_by_record` —— 这里原来只看 `.workbuddy`，
        // 于是用独立 CLI 装的用户拿不到装机时间，「刚装好」的宽限期直接失效。
        "workbuddy" => vec![harness_home("WORKBUDDY_CONFIG_DIR", ".workbuddy").join("plugins/installed_plugins.json"),
                            harness_home("CODEBUDDY_CONFIG_DIR", ".codebuddy").join("plugins/installed_plugins.json")],
        _ => return None,
    };
    ledgers.into_iter().find_map(|ledger| {
        let document: Value = serde_json::from_str(&fs::read_to_string(ledger).ok()?).ok()?;
        let plugins = document.get("plugins")?.as_object()?;
        plugins.iter()
            .filter(|(name, _)| name.as_str() == PLUGIN_ID)
            .filter_map(|(_, entries)| entries.as_array()?.first()?.get("installedAt")?.as_str())
            .map(str::to_owned)
            .next()
    })
}

/// 装机时间的兜底：插件目录自己的修改时间。
///
/// 🔴 **Hermes 没有别的来源。** 「刚装好，等第一个新会话」这个宽限期靠装机时间撑着，
/// 而它有两个来源：`localize.py` 写的装机记录，和 harness 账本里的 `installedAt`。
/// Hermes 两个都没有 —— 它的 CLI 直接从 git 装，不经过我们的本地化那一步（那一步要先
/// clone，而不用 clone 正是 Hermes 这条路唯一的好处），账本里也不记时间。
/// 结果是装完那一刻界面就摊开整张排查清单，而用户其实什么都没做错
/// （2026-09-03 实机跑完 Hermes 安装当场看到）。
///
/// 目录时间不精确（之后动过插件文件就会变新），但它只用来回答「是不是刚装的」，
/// 往新的方向偏一点只会让宽限期稍微长一些，不会把坏了的说成好的。
fn dir_installed_at(harness: &str) -> Option<String> {
    let modified = installed_dir(harness)?.metadata().ok()?.modified().ok()?;
    let seconds = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(rfc3339(seconds))
}

/// `SystemTime` → `2026-09-03T04:21:07Z`，前端 `Date.parse` 认得的形状。
///
/// 自己算是因为这个 crate 没有 chrono/time 依赖，而为了一个时间戳引一整个日期库
/// 不划算。算法是 Howard Hinnant 的 days-from-civil 的逆运算，闰年、世纪闰年都在内。
pub(crate) fn rfc3339(seconds: u64) -> String {
    let (days, rest) = ((seconds / 86_400) as i64, seconds % 86_400);
    // 以 0000-03-01 为纪元（把闰日挪到年末，月份长度就有了规律）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = era * 400 + yoe + if month <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            year, month, day, rest / 3_600, (rest % 3_600) / 60, rest % 60)
}

/// 「这家装了没有」的**唯一判据**：账本优先，这家没有账本（或从没用过）才退回看目录。
///
/// 单独拎出来是因为它有两个调用方 —— 界面，和真机安装测试。两边各写一遍的话，
/// 测试就会在一条和界面不同的判据上通过（Hermes 正是这样：它没有账本，
/// `installed_by_record` 对它永远是 None）。
pub(crate) fn is_installed(harness: &str) -> bool {
    installed_by_record(harness).unwrap_or_else(|| installed_dir(harness).is_some())
}

/// 首选位置（新布局）。卸载与「装到哪」的显示用它。
pub fn plugin_dir(harness: &str) -> Option<PathBuf> {
    plugin_dirs(harness).into_iter().next()
}

/// 「装没装」的**权威答案在 harness 自己的账本里**，不在我们猜的目录里。
///
/// 🔴 装是 harness 干的（用户的 agent 跑它自己的 CLI），所以另记一本账必然会漂 ——
/// 2026-09-03 一天之内漂了两次：claude-code / codex 改成本地 marketplace 布局，
/// 以及 Hermes 在 Windows 上根本不住 `~/.hermes`（住 `%LOCALAPPDATA%\hermes`）。
/// 每漂一次，界面就把装好的说成没装。
///
/// 所以这里读各家自己记下的那一份：
/// - claude-code / workbuddy：`plugins/installed_plugins.json`
/// - codex：`config.toml` 里的 `[plugins."agent-avatar@…"]`
/// - dsh：`cordis.patch.yml` 里那段 insert
///
/// 返回值分三种：`Some(true)` 账本说装了；`Some(false)` 账本在、但没有我们这一条
/// （**文件在也算没装** —— 那正是「拷了文件却没登记」，harness 根本不会加载它）；
/// `None` 账本读不到（这家没有账本，或者从没用过），退回去看目录。
/// Claude Code 系账本里那把键的样子：`"agent-avatar@agent-avatar"`，**带两端引号**。
/// 引号不是装饰 —— 没有收尾那个引号，`"agent-avatar@agent-avatar-local"` 也会命中。
fn json_key() -> String { format!("\"{PLUGIN_ID}\"") }

pub(crate) fn installed_by_record(harness: &str) -> Option<bool> {
    let listed = |path: PathBuf, needle: &str| -> Option<bool> {
        let raw = fs::read_to_string(path).ok()?;
        Some(raw.contains(needle))
    };
    match harness {
        "claude-code" => listed(
            harness_home("CLAUDE_CONFIG_DIR", ".claude").join("plugins/installed_plugins.json"),
            &json_key()),
        // WorkBuddy 的同一个 CLI 有两个 home：app 读 .workbuddy，独立 CLI 默认读 .codebuddy。
        // 任一本账记着就算装了 —— 用户可能只用其中一个。
        //
        // 变量名是 `WORKBUDDY_CONFIG_DIR`，**不是我们原来写的 `WORKBUDDY_HOME`** ——
        // 后者是我们自己发明的，CLI 根本不读它（它自己的 `getUserConfigPath` 只认
        // `WORKBUDDY_CONFIG_DIR` 和 `CODEBUDDY_CONFIG_DIR`）。默认值一样所以平时不显，
        // 但用户一旦设了那个变量，装进去的和我们去找的就是两个地方。
        //
        // 🔴 **两个文件都要看，`installed_plugins.json` 一个人不够。** 从**目录型**
        // marketplace 装的插件根本不进那本账 —— WorkBuddy 不往 cache 里拷，只在
        // `settings.json` 的 `enabledPlugins` 里翻一个键。而我们正是目录型
        //（`plugin marketplace add <打包树>`）。2026-09-03 实机对照：
        //
        //   $ codebuddy plugin install agent-avatar@agent-avatar
        //   ✔ Successfully installed plugin: agent-avatar@agent-avatar.
        //   installed_plugins.json → 没有这一条（连早先那次装的都没有）
        //   settings.json         → "agent-avatar@agent-avatar": true
        //
        // 只读前者的话，装成功之后界面照样说「未安装」。卸载会把 settings.json 里那个键
        // 删掉，所以拿它当判据是准的。
        "workbuddy" => {
            let mut ledger_seen = false;
            for root in [harness_home("WORKBUDDY_CONFIG_DIR", ".workbuddy"),
                         harness_home("CODEBUDDY_CONFIG_DIR", ".codebuddy")] {
                for ledger in ["plugins/installed_plugins.json", "settings.json"] {
                    match listed(root.join(ledger), &json_key()) {
                        Some(true) => return Some(true),
                        Some(false) => ledger_seen = true,
                        None => {}
                    }
                }
            }
            // 一本都读不到 = 这家没用过，退回去看目录；读到了但没有我们这条 = 没装
            ledger_seen.then_some(false)
        }
        "codex" => listed(harness_home("CODEX_HOME", ".codex").join("config.toml"),
                          &format!("[plugins.\"{PLUGIN_ID}\"]")),
        "dsh" => listed(harness_home("DSH_HOME", ".dsh").join("cordis.patch.yml"), "id: agent-avatar"),
        // Hermes 没有我们读得懂的账本（它记在自己的 sqlite 里），只能看目录
        _ => None,
    }
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
        let installed = is_installed(harness);
        json!({
            "harness": harness,
            "installed": installed,
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
            // 装机时那次验证的记录（`localize.py` 跑通了冒烟自检才会有）。
            // 它不是「装没装」的证据 —— 那个读账本；它是「这台机器上跑得起来」的证据。
            "installRecord": crate::hermes::install_record(harness),
            // 账本里的安装时间。mac 那条路不跑 localize，没有上面那条记录，
            // 但账本有时间戳 —— 「刚装完还没上报」在两个平台上都该说得出来。
            "installedAt": ledger_installed_at(harness).or_else(|| dir_installed_at(harness)),
        })
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::{home, installed_by_record, installed_dir, plugin_dir, plugin_dirs, rfc3339,
                HARNESSES, LOCAL_MARKETPLACE};
    use std::{env, fs};

    /// 手写的日期换算，闰年那几个坎必须钉住。前端拿它去 `Date.parse` 比「是不是刚装的」，
    /// 算错一天，宽限期就会在错误的时刻开合。
    #[test]
    fn epoch_seconds_become_a_timestamp_the_frontend_can_parse() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");   // 世纪闰年，是闰日
        assert_eq!(rfc3339(1_709_164_800), "2024-02-29T00:00:00Z"); // 普通闰年
        assert_eq!(rfc3339(4_107_542_400), "2100-03-01T00:00:00Z"); // 2100 不闰
        assert_eq!(rfc3339(1_756_874_467), "2025-09-03T04:41:07Z"); // 带时分秒
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
        // 判据是各家实际把插件放在哪 —— 布局变了这里必须跟着改，
        // 否则表现是「装完了界面还说没装」。
        for harness in ["claude-code", "codex", "workbuddy"] {
            assert!(plugin_dir(harness).unwrap().ends_with(LOCAL_MARKETPLACE), "{harness}");
        }
        assert!(plugin_dir("hermes").unwrap().ends_with("plugins/agent-avatar"));
        assert!(plugin_dir("dsh").unwrap().ends_with("plugins/agent-avatar"));
    }

    #[test]
    fn the_harness_ledger_beats_our_guess_about_directories() {
        // 装是 harness 干的，所以「装没装」的权威答案在它自己的账本里。
        // 我们另记一本账必然会漂 —— 2026-09-03 一天之内漂了两次。
        let scratch = std::env::temp_dir().join(format!("agent-avatar-ledger-{}", std::process::id()));
        let claude = scratch.join(".claude");
        fs::create_dir_all(claude.join("plugins")).unwrap();
        let previous = env::var("CLAUDE_CONFIG_DIR").ok();
        env::set_var("CLAUDE_CONFIG_DIR", &claude);

        // 账本在、但没有我们这一条 —— **文件在也算没装**：拷了文件却没登记的话，
        // harness 根本不会加载它（实测撞到过：重启 app 后 Plugins 页里什么都没有）。
        fs::write(claude.join("plugins/installed_plugins.json"), r#"{"plugins":{}}"#).unwrap();
        fs::create_dir_all(claude.join(LOCAL_MARKETPLACE)).unwrap();
        assert_eq!(installed_by_record("claude-code"), Some(false));

        // 账本记着**我们这个 id** 才算装了
        fs::write(claude.join("plugins/installed_plugins.json"),
                  r#"{"plugins":{"agent-avatar@agent-avatar":[{"scope":"user"}]}}"#).unwrap();
        assert_eq!(installed_by_record("claude-code"), Some(true));

        // 🔴 别的 marketplace 里同名的那个**不是我们的**：我们没装它，也卸不掉它。
        // 认前缀的那一版在这里说「已安装」，于是点卸载得到
        // `Plugin "agent-avatar@agent-avatar" is not installed in user scope.`
        fs::write(claude.join("plugins/installed_plugins.json"),
                  r#"{"plugins":{"agent-avatar@agent-avatar-local":[{"scope":"user"}]}}"#).unwrap();
        assert_eq!(installed_by_record("claude-code"), Some(false),
                   "agent-avatar@agent-avatar-local 是别人的登记，不能算我们装了");

        // 账本读不到（这家没用过）→ 退回去看目录，别把没账本当成没装
        fs::remove_file(claude.join("plugins/installed_plugins.json")).unwrap();
        assert_eq!(installed_by_record("claude-code"), None);
        assert!(installed_dir("claude-code").is_some(), "退路还得能认出目录");

        match previous {
            Some(value) => env::set_var("CLAUDE_CONFIG_DIR", value),
            None => env::remove_var("CLAUDE_CONFIG_DIR"),
        }
        let _ = fs::remove_dir_all(&scratch);
        // Hermes 记在自己的 sqlite 里，我们读不懂 —— 那一家只能看目录
        assert_eq!(installed_by_record("hermes"), None);
    }

    /// Codex 那一半：账本是 `config.toml`，判据是整行 `[plugins."<id>"]`。
    ///
    /// 🔴 这一条钉的是实机撞到的那个组合：`codex plugin remove` 对**没装的**插件照样
    /// 返回 0（原话：``Removed plugin `agent-avatar` from marketplace `agent-avatar`.``），
    /// 所以「卸载成功」这个结论完全靠账本。账本认前缀的话，机器上早先按提示词装的
    /// `agent-avatar@local` 会一直命中 —— 表现就是卸载报成功、界面还是「已安装」。
    #[test]
    fn codex_only_counts_our_own_marketplace() {
        let scratch = std::env::temp_dir().join(format!("agent-avatar-codex-{}", std::process::id()));
        fs::create_dir_all(&scratch).unwrap();
        let previous = env::var("CODEX_HOME").ok();
        env::set_var("CODEX_HOME", &scratch);
        let config = scratch.join("config.toml");

        fs::write(&config, "[plugins.\"agent-avatar@agent-avatar\"]\nenabled = true\n").unwrap();
        assert_eq!(installed_by_record("codex"), Some(true));

        fs::write(&config, "[plugins.\"agent-avatar@local\"]\nenabled = true\n").unwrap();
        assert_eq!(installed_by_record("codex"), Some(false),
                   "agent-avatar@local 是别人的登记，卸载动不了它");

        match previous {
            Some(value) => env::set_var("CODEX_HOME", value),
            None => env::remove_var("CODEX_HOME"),
        }
        let _ = fs::remove_dir_all(&scratch);
    }

    /// WorkBuddy：判据不能只押在 `installed_plugins.json` 上。
    ///
    /// 🔴 目录型 marketplace 装出来的插件**不进那本账** —— 2026-09-03 实机上
    /// `codebuddy plugin install agent-avatar@agent-avatar` 报成功，
    /// `installed_plugins.json` 里从头到尾没出现过 agent-avatar，
    /// 只有 `settings.json` 的 `enabledPlugins` 多了一个键。
    #[test]
    fn workbuddy_counts_the_enabled_plugins_map_too() {
        let scratch = std::env::temp_dir().join(format!("agent-avatar-wb-{}", std::process::id()));
        let app = scratch.join(".workbuddy");
        let cli = scratch.join(".codebuddy");
        fs::create_dir_all(app.join("plugins")).unwrap();
        fs::create_dir_all(cli.join("plugins")).unwrap();
        let previous = (env::var("WORKBUDDY_CONFIG_DIR").ok(), env::var("CODEBUDDY_CONFIG_DIR").ok());
        env::set_var("WORKBUDDY_CONFIG_DIR", &app);
        env::set_var("CODEBUDDY_CONFIG_DIR", &cli);

        // 两本账都在、都没有我们这条 → 没装
        for root in [&app, &cli] {
            fs::write(root.join("plugins/installed_plugins.json"), r#"{"plugins":{}}"#).unwrap();
            fs::write(root.join("settings.json"), r#"{"enabledPlugins":{}}"#).unwrap();
        }
        assert_eq!(installed_by_record("workbuddy"), Some(false));

        // 只有 settings.json 记着 —— 这正是目录型 marketplace 装完的真实样子
        fs::write(cli.join("settings.json"),
                  r#"{"enabledPlugins":{"agent-avatar@agent-avatar":true}}"#).unwrap();
        assert_eq!(installed_by_record("workbuddy"), Some(true),
                   "只读 installed_plugins.json 的话，装成功了界面还说没装");

        // 别人的登记仍然不算我们的
        fs::write(cli.join("settings.json"),
                  r#"{"enabledPlugins":{"agent-avatar@agent-avatar-local":true}}"#).unwrap();
        assert_eq!(installed_by_record("workbuddy"), Some(false));

        match previous.0 { Some(v) => env::set_var("WORKBUDDY_CONFIG_DIR", v), None => env::remove_var("WORKBUDDY_CONFIG_DIR") }
        match previous.1 { Some(v) => env::set_var("CODEBUDDY_CONFIG_DIR", v), None => env::remove_var("CODEBUDDY_CONFIG_DIR") }
        let _ = fs::remove_dir_all(&scratch);
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

}
