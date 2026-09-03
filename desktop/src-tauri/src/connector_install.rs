//! 装 / 卸 connector —— **由 app 来做**。
//!
//! 🔴 这是对上一版方案的推翻。上一版把安装交给用户的 agent：app 出一段提示词，用户粘给
//! 手边的 agent，agent 去跑命令。两轮实机测试（提示词交给真实的 claude / codebuddy /
//! hermes / dsh CLI）一共暴露 **14 个缺陷**，成因是同一件事 —— **提示词是一段程序，
//! 而执行它的解释器不确定**。而确定性的那部分（改写 + 冒烟自检）在约 20 次运行里零失败。
//! 压垮它的是 Codex：提示词写的是 `plugin install`，真实动词是 `plugin add`，错了很久没
//! 人发现，因为它从没在真的 CLI 上跑过。我们能测 4 个 CLI 各一个模型，而用户手里是几十种
//! 模型 × 版本的组合 —— 那个矩阵永远测不完。详见
//! private/RELEASE-CONNECTOR-WIZARD-DESIGN.md「2026-09-03 定案」。
//!
//! **但当初放弃「app 自己装」的理由是绑错了。** 那个理由是「app 猜 harness 的目录布局会漂」
//! —— 完全正确（一天漂过三次）。可修好它的东西不是 agent，是**调 harness 自己的 CLI，
//! 而不是写它的文件**。这两件事被绑成了一个决定，于是为了得到后者，把前者的全部不确定性
//! 一起接受了。最硬的证据：`codex plugin add` 会把插件拷进 `~/.codex/plugins/cache/…`
//! 并把**那份**报成 installed root；手写 config.toml 建不出它 —— 那是个半装。
//!
//! 所以这里的规矩是：**登记一律交给 harness 自己的 CLI**。唯一的例外是 dsh，它根本没有
//! CLI，那个 patch 文件就是它的安装机制本身。
//!
//! 检测（装没装、通没通）仍在 `connectors.rs`。
use serde_json::{json, Value};
use std::{env, fs,
          path::{Path, PathBuf},
          process::Command};
use tauri::Manager;

use crate::connectors::{harness_home, home, hermes_homes, rfc3339, HARNESSES};

/// app 的 bundle identifier。**必须与 tauri.conf.json 的 `identifier` 一致**（有测试盯着）——
/// 数据目录就是按它命名的，而无界面卸载那条路径拿不到 AppHandle，只能自己算。
const APP_IDENTIFIER: &str = "io.github.joyparkray.agentavatar";

/// 各家插件树在 marketplace 里的相对位置 + 本地化要改的那个文件 + 冒烟自检要看的状态文件。
///
/// 与 `connectors/localize.py` 的 `LAYOUT` 同源。布局一变这张表就要跟着改，否则症状是
/// 「装好了，什么也不发生」。
struct Layout {
    /// 相对插件树根：要把解释器写进去的那个文件（Hermes 没有）
    config: Option<&'static str>,
    /// 相对插件树根：冒烟自检要跑的那个 hook
    hook: Option<&'static str>,
    /// 冒烟自检要看它落没落盘
    state: &'static str,
    /// 喂给 hook 的那条事件
    event: &'static str,
}

fn layout(harness: &str) -> Layout {
    match harness {
        "claude-code" => Layout { config: Some("hooks/hooks.json"), hook: Some("hooks/agent-avatar-hook.py"),
                                  state: "agent-avatar-state.claude-code.json", event: "UserPromptSubmit" },
        "codex" => Layout { config: Some("hooks.json"), hook: Some("scripts/agent-avatar-hook.py"),
                            state: "agent-avatar-state.codex.json", event: "UserPromptSubmit" },
        "workbuddy" => Layout { config: Some("hooks/hooks.json"), hook: Some("hooks/agent-avatar-hook.py"),
                                state: "agent-avatar-state.workbuddy.json", event: "UserPromptSubmit" },
        "dsh" => Layout { config: Some("index.mjs"), hook: Some("agent-avatar-hook.py"),
                          state: "agent-avatar-state.dsh.json", event: "pre_llm_call" },
        // Hermes 的插件是 in-process 的 Python 包，跑在 Hermes 自己的解释器里、不 spawn
        // 任何进程 —— 五家里唯一不需要本地化、也无法在装机时冒烟自检的。
        _ => Layout { config: None, hook: None, state: "agent-avatar-state.json", event: "" },
    }
}

// ---------------------------------------------------------------------------
// 找 harness 自己的 CLI
// ---------------------------------------------------------------------------

/// 那家的可执行文件叫什么。
fn cli_name(harness: &str) -> Option<&'static str> {
    match harness {
        "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "workbuddy" => Some("codebuddy"),
        "hermes" => Some("hermes"),
        _ => None,                       // dsh 没有 CLI
    }
}

/// PATH 之外还要找的地方。
///
/// 🔴 **不能只靠 PATH。** app 是从资源管理器/Dock 启动的，拿到的环境和用户终端里的不是
/// 同一份；而且 Codex 那个根本就不在任何 PATH 上（见 `newest_codex`）。只认 PATH 的表现是
/// 「用户明明装了，app 说找不到」。
fn cli_candidates(harness: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let name = match cli_name(harness) { Some(name) => name, None => return found };

    // npm 全局装的两家
    let npm_dirs: Vec<PathBuf> = if cfg!(windows) {
        vec![joined(&env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| joined(&home(), "AppData/Roaming")), "npm")]
    } else {
        node_bin_dirs()
    };
    for dir in npm_dirs {
        for suffix in exe_suffixes() {
            found.push(dir.join(format!("{name}{suffix}")));
        }
    }

    match harness {
        "hermes" => {
            for root in hermes_homes() {
                for suffix in exe_suffixes() {
                    found.push(root.join("bin").join(format!("hermes{suffix}")));
                }
            }
        }
        "codex" => found.extend(newest_codex()),
        _ => {}
    }
    found
}

/// POSIX 上 node 的全局 bin 可能在的地方。
///
/// 🔴 **不能指望 PATH。** macOS 上从 Finder / Dock 启动的进程**不继承用户 shell 的 PATH** ——
/// 那是 `.zshrc` 里配的，而 GUI 进程根本没跑过它。而 Claude Code 和 CodeBuddy 都是 npm
/// 全局装的，于是「用户明明装了，app 说找不到」在 mac 上会是默认结果。
///
/// 版本管理器（nvm / fnm / volta / asdf）把 node 装在带版本号的目录里，所以那几处要枚举。
/// nvm 尤其常见，而它的 bin 目录长 `~/.nvm/versions/node/v22.3.0/bin` 这样。
fn node_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        joined(&home(), ".npm-global/bin"),
        joined(&home(), ".local/bin"),
        joined(&home(), ".volta/bin"),
        joined(&home(), ".bun/bin"),
        joined(&home(), ".asdf/shims"),
    ];
    // 版本管理器：枚举出来按新旧排，新的在前
    for versioned in [joined(&home(), ".nvm/versions/node"), joined(&home(), ".local/share/fnm/node-versions")] {
        let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
        if let Ok(entries) = fs::read_dir(&versioned) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                // fnm 的布局多一层 `installation/`
                let bin = if bin.is_dir() { bin } else { entry.path().join("installation").join("bin") };
                if bin.is_dir() {
                    let stamp = entry.metadata().and_then(|meta| meta.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    found.push((stamp, bin));
                }
            }
        }
        found.sort_by(|left, right| right.0.cmp(&left.0));
        dirs.extend(found.into_iter().map(|(_, path)| path));
    }
    dirs
}

/// Windows 上一个名字对应几种后缀：npm 装出来的是 `.cmd` 垫片，不是 `.exe`。
fn exe_suffixes() -> &'static [&'static str] {
    if cfg!(windows) { &[".cmd", ".exe", ".bat", ""] } else { &[""] }
}

/// Codex 的 CLI **不在 PATH 上，但确实存在**。
///
/// Windows 的 ChatGPT app 自带它，装在 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`
/// —— 目录名是随版本变的哈希，所以只能枚举后按修改时间取最新的那个。
///
/// 🔴 这一条曾经让我们得出完全错误的结论：以为「Windows 上没有 codex CLI」，据此写了一整条
/// 手改 config.toml 的岔路。那条路只写登记、**不产生 codex 真正加载的那份缓存副本**，
/// 是个半装 —— 而且很可能正是 Codex 一次都没上报过的真实原因。
fn newest_codex() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(local) = env::var("LOCALAPPDATA") {
        roots.push(joined(&PathBuf::from(local), "OpenAI/Codex/bin"));
    }
    roots.push(joined(&home(), ".codex/bin"));

    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for root in roots {
        let entries = match fs::read_dir(&root) { Ok(entries) => entries, Err(_) => continue };
        for entry in entries.flatten() {
            for suffix in exe_suffixes() {
                let binary = entry.path().join(format!("codex{suffix}"));
                if binary.is_file() {
                    let stamp = entry.metadata().and_then(|meta| meta.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    candidates.push((stamp, binary));
                }
            }
        }
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    candidates.into_iter().map(|(_, path)| path).collect()
}

/// 解析出这家 CLI 的可执行文件。先试 PATH 上的名字，再试已知位置。
pub fn resolve_cli(harness: &str) -> Option<PathBuf> {
    let name = cli_name(harness)?;
    // PATH 上有同名的就用它 —— 用户自己装的版本优先于我们猜到的位置
    if run(Path::new(name), &["--version"]).is_ok() {
        return Some(PathBuf::from(name));
    }
    cli_candidates(harness).into_iter().find(|path| path.is_file())
}

// ---------------------------------------------------------------------------
// 跑命令
// ---------------------------------------------------------------------------

/// 跑一条命令，失败时把 harness 自己说的话原样带回来。
///
/// 错误信息**必须是它的原话**：这条链路上我们能给用户的唯一线索就是 harness 的输出
/// （「Marketplace undefined is not found.」这种），我们自己改写一遍只会把它变模糊。
/// 一条命令跑多久算跑死了。
///
/// 这些 CLI 有的会去够网络（marketplace 元数据、git clone），所以不能定得太短；但**必须有**：
/// 一个在非 TTY 下等输入的 CLI 会一直等下去，而我们是它的父进程。
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// 跑一条命令，失败时把 harness 自己说的话原样带回来。
///
/// 错误信息**必须是它的原话**：这条链路上我们能给用户的唯一线索就是 harness 的输出
/// （「Marketplace undefined is not found.」这种），我们自己改写一遍只会把它变模糊。
///
/// 🔴 两条硬性防护，缺一条都能让「安装」这个按钮永远转下去：
///
/// - **stdin 给 null。** CLI 发现自己不在终端里时，未必会报错退出 —— 它可能就那么等着
///   （确认条款、覆盖提示）。给它一个立刻 EOF 的 stdin，它就只能自己决定。
/// - **超时后杀掉。** 上一条挡不住铁了心要等的实现，也挡不住卡在网络上的那种。
///   宁可报「超时」让用户看见，也不能让安装线程停在那儿。
fn run(program: &Path, args: &[&str]) -> Result<String, String> {
    use std::io::Read;

    let mut command = Command::new(program);
    command.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);          // CREATE_NO_WINDOW：别闪控制台
    }
    let mut child = command.spawn().map_err(|error| format!("{}: {error}", program.display()))?;

    // 管道要在等待期间被读走，否则输出填满缓冲区时子进程会阻塞在写上 —— 那是另一种挂死，
    // 而且比等 stdin 更难看出来。各起一个线程收。
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_thread = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = out_pipe.as_mut() { let _ = pipe.read_to_end(&mut buffer); }
        buffer
    });
    let err_thread = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(pipe) = err_pipe.as_mut() { let _ = pipe.read_to_end(&mut buffer); }
        buffer
    });

    let deadline = std::time::Instant::now() + COMMAND_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => return Err(format!("{}: {error}", program.display())),
        }
    };

    let stdout = String::from_utf8_lossy(&out_thread.join().unwrap_or_default()).trim().to_string();
    let stderr = String::from_utf8_lossy(&err_thread.join().unwrap_or_default()).trim().to_string();
    let described = format!("{} {}", program.display(), args.join(" "));
    match status {
        None => Err(format!("{described}：{} 秒没有返回，已终止{}",
                            COMMAND_TIMEOUT.as_secs(),
                            if stderr.is_empty() { String::new() } else { format!("（{stderr}）") })),
        Some(status) if status.success() => Ok(if stdout.is_empty() { stderr } else { stdout }),
        Some(_) => Err(format!("{described}: {}", if stderr.is_empty() { stdout } else { stderr })),
    }
}

/// `<cli> plugin --help` 里列出的子命令名（含别名）。
///
/// 三种形状都要认，因为三家各写各的：
///
/// ```text
///   install [options] <plugin>          Claude Code：光名字
///   uninstall|remove [options] <plugin> CodeBuddy：竖线分隔的别名
///   remove (rm, uninstall)              Hermes：括号里的别名
/// ```
fn subcommands(help: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in help.lines() {
        // 子命令行是缩进的；正文和 Usage 不是
        if !line.starts_with("  ") || line.trim().is_empty() { continue; }
        let spec = line.trim();
        // 名字部分在第一段空白之前，别名用 | 或 (,) 挂在后面
        let head: String = spec.chars().take_while(|c| !c.is_whitespace()).collect();
        let aliases: String = spec.chars().skip(head.len())
            .take_while(|&c| c != ' ' || false).collect::<String>();
        let mut candidates = vec![head];
        if let Some(open) = spec.find('(') {
            if let Some(close) = spec[open..].find(')') {
                candidates.push(spec[open + 1..open + close].to_string());
            }
        }
        let _ = aliases;
        for chunk in candidates {
            for name in chunk.split(['|', ',']) {
                let name = name.trim();
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
                    names.push(name.to_string());
                }
            }
        }
    }
    names
}

/// 「装」和「卸」这两个动词，**问 CLI 自己**，而不是按 harness 名字写死。
///
/// 🔴 我们曾经对 Codex 写死了 `plugin install` / `plugin uninstall`，而它其实是
/// `add` / `remove` —— 两个平台都错，而且错了很久没发现。动词改名是这类外部 CLI
/// 最常见的变更，问一句 `--help` 就能扛过去，比按版本号分支稳。
///
/// 探测不出来时退回已知的默认值：那至少是今天实测过的。
fn plugin_verbs(cli: &Path, harness: &str) -> (String, String) {
    let fallback = if harness == "codex" { ("add", "remove") } else { ("install", "uninstall") };
    let help = match run(cli, &["plugin", "--help"]) { Ok(text) => text, Err(_) => return owned(fallback) };
    let names = subcommands(&help);
    let pick = |options: &[&str], default: &str| -> String {
        options.iter().find(|option| names.iter().any(|name| name == *option))
            .map(|option| option.to_string())
            .unwrap_or_else(|| default.to_string())
    };
    // 顺序即偏好：两个都在时（有的 CLI 互为别名）用前面那个
    (pick(&["install", "add"], fallback.0), pick(&["uninstall", "remove"], fallback.1))
}

fn owned(pair: (&str, &str)) -> (String, String) {
    (pair.0.to_string(), pair.1.to_string())
}

// ---------------------------------------------------------------------------
// 打包进来的那份 & 工作副本
// ---------------------------------------------------------------------------

/// 把一段用 `/` 写的相对路径接到 `base` 后面 —— **一段一段接**。
///
/// 🔴 **不能写成 `base.join("a/b")`。** Windows 上 `resource_dir()` 返回的是 `\\?\` 开头的
/// **verbatim 路径**，而 verbatim 路径**关闭了路径规范化**：里面的 `/` 不再被当作分隔符，
/// 于是 `\\?\C:\app\resources/connectors` 这种东西**根本解析不到**，`is_dir()` 直接为假。
///
/// 2026-09-03 实机撞到：便携版点「安装」报「app 里没有连接器树」，而那个目录明明在。
/// 单独验过：普通路径无论用哪种斜杠都能解析，verbatim 路径只认反斜杠。
///
/// 这个坑只在 verbatim 路径上出现，所以它**只在打包后的真 app 里发作** —— 开发时、
/// 测试里都摸不到，因为那些路径是我们自己拼的普通路径。
fn joined(base: &Path, relative: &str) -> PathBuf {
    relative.split('/').filter(|part| !part.is_empty())
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

/// app 里带的连接器树与解释器。
fn bundled(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let root = joined(&app.path().resource_dir()
        .map_err(|error| format!("找不到资源目录：{error}"))?, "resources/connectors");
    let tree = root.join("marketplace");
    let python = joined(&root, python_relative());
    if !tree.is_dir() {
        return Err(format!("app 里没有连接器树（{}）—— 构建时漏跑 connectors/build-bundle.sh", tree.display()));
    }
    if !python.is_file() {
        return Err(format!("app 里没有解释器（{}）—— 构建时漏跑 connectors/fetch-python.sh", python.display()));
    }
    Ok((tree, python))
}

/// 工作副本的根。下面按版本分目录，见 `lay_out_tree`。
///
/// **不能就地用资源目录**：本地化要改写 hooks.json，而 `C:\Program Files` / `/Applications`
/// 下是只读的；而且 marketplace 登记进 harness 之后那个路径要一直有效，app 升级时资源目录
/// 整个换掉，登记就会指向不存在的东西。
fn working_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| format!("找不到数据目录：{error}"))?;
    Ok(dir.join("connectors"))
}

/// 递归拷贝（标准库没有）。
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        // 🔴 用 `path().is_dir()`（会跟随符号链接）而不是 `file_type().is_dir()`（不跟随）。
        // 打包进来的 macOS 解释器里有符号链接，其中指向目录的那种在后者眼里既不是目录、
        // 又会被当成文件去 `fs::copy` —— 那一步直接报错，安装当场失败。
        // 跟随会把链接指向的内容复制一份（多占一点空间），但结果是对的。
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// 解释器在工作副本里的相对位置。
fn python_relative() -> &'static str {
    if cfg!(windows) { "python/python.exe" } else { "python/bin/python3" }
}

/// 把打包的那棵树**和解释器**铺进「这个版本自己的目录」，返回可以直接用的两个路径。
///
/// 🔴 **解释器不能就地用资源目录里那份。** 资源目录是 Tauri 按当前可执行文件的位置在运行时
/// 算出来的，所以用户装到哪都对 —— 但那正是问题：hook 的命令行里烤进的是解释器的**绝对
/// 路径**，用户之后把 app 挪个位置、或者卸载重装到别的盘，五家 harness 配置里那些命令行就
/// 指向了不存在的东西。而这种失败是**静默的**：hook 跑不起来，退出码没人看，形象就是不动了。
/// 数据目录的位置与安装位置无关，命令行一次写对就一直有效。
///
/// 🔴 **每个版本一个目录，不覆盖。** 升级时旧的 connector 很可能**正在被使用** —— 某个
/// Claude Code 会话开着，它的 hook 随时会拉起那个 python.exe。Windows 上删/改一个正在执行
/// 的文件会直接 Access denied，于是「app 自动更新」会变成「更新到一半，两个版本都不完整」。
/// 所以新版本铺到自己的目录里，旧的原地不动，等它自然没人用了再清。
/// 代价是短时间内多占一份 21MB。
fn lay_out_tree(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let (bundle_tree, bundle_python) = bundled(app)?;
    let version = bundled_version(&bundle_tree);
    let root = working_root(app)?;
    let slot = root.join("versions").join(&version);
    let tree = slot.join("marketplace");
    let python = joined(&slot, python_relative());

    if !tree.is_dir() || !python.is_file() {
        // 先铺进暂存目录再整体改名：中途失败（磁盘满、被杀软拦）时留下的是一个带 `.staging-`
        // 前缀的半成品，而不是一个看起来像正式版本、其实缺文件的目录。
        let staging = root.join("versions").join(format!(".staging-{version}"));
        let _ = fs::remove_dir_all(&staging);
        copy_tree(&bundle_tree, &staging.join("marketplace"))
            .map_err(|error| format!("拷贝连接器树失败：{error}"))?;
        let python_source = bundle_python.parent()
            .and_then(|dir| if cfg!(windows) { Some(dir.to_path_buf()) } else { dir.parent().map(Path::to_path_buf) })
            .ok_or_else(|| "自带解释器的位置不对".to_string())?;
        copy_tree(&python_source, &staging.join("python"))
            .map_err(|error| format!("拷贝解释器失败：{error}"))?;

        let _ = fs::remove_dir_all(&slot);
        if let Some(parent) = slot.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("{error}"))?;
        }
        fs::rename(&staging, &slot)
            .map_err(|error| format!("启用连接器 {version} 失败：{error}"))?;
    }
    if !python.is_file() {
        return Err(format!("解释器没拷成：{}", python.display()));
    }
    prune_old_versions(&root, &version);
    Ok((tree, python))
}

/// 清掉不再是当前版本的那些目录。
///
/// **失败就算了**：清不掉多半正是因为里面那个解释器还被某个会话的 hook 用着，
/// 而那恰恰是不该动它的理由。下次装的时候会再试一遍。
fn prune_old_versions(root: &Path, keep: &str) {
    let versions = root.join("versions");
    if let Ok(entries) = fs::read_dir(&versions) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name != keep {
                force_remove_dir(&entry.path());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 本地化：把解释器写进 hook 的命令行
// ---------------------------------------------------------------------------

/// 把解释器路径变成**命令行里能用**的形状。
///
/// 正斜杠：Windows API 两种分隔符都收，但 Claude Code 在 Windows 上默认用 Git Bash，
/// 而 bash 会把反斜杠当转义（`C:\Python\python.exe` 变成 `C:Pythonpython.exe`）。
///
/// 空格只在 **Windows** 上是问题：那里命令行的解释器那一段**不能加引号**（PowerShell 会把
/// 带引号的首 token 当成字符串表达式然后报错），所以带空格的路径根本表达不出来 ——
/// 换成 8.3 短路径，它没有空格，两个 shell 都认。POSIX 的 shell 没有这个毛病，
/// 那边直接加引号（见 `interpreter_token`）。
fn command_line_path(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    if !text.contains(' ') {
        return text.replace('\\', "/");
    }
    #[cfg(windows)]
    {
        if let Some(short) = short_path(&text) {
            if !short.contains(' ') {
                return short.replace('\\', "/");
            }
        }
    }
    // 短路径拿不到（卷上关了 8.3 生成）就只能原样返回 —— 后面的冒烟自检会当场发现它跑不了，
    // 而那正是我们要的：**响亮地失败**，而不是装完之后形象永远不动。
    text.replace('\\', "/")
}

#[cfg(windows)]
fn short_path(long: &str) -> Option<String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide: Vec<u16> = std::ffi::OsStr::new(long).encode_wide().chain(Some(0)).collect();
    let mut buffer = vec![0u16; 1024];
    let written = unsafe { GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
    if written == 0 || written as usize >= buffer.len() {
        return None;
    }
    buffer.truncate(written as usize);
    Some(std::ffi::OsString::from_wide(&buffer).to_string_lossy().to_string())
}

/// 解释器在命令行里的那一段 —— **Windows 不加引号，POSIX 加**。
///
/// 🔴 「不能加引号」是 **PowerShell 的毛病**，不是通则，而代码一度无条件照做。
/// macOS 上这条会直接把链路打断：解释器住在
/// `~/Library/Application Support/<bundle id>/…`，**那里就带空格**，而 macOS 没有
/// 8.3 短路径可退 —— 不加引号的话，shell 在 `Application` 和 `Support` 之间就断开了。
/// POSIX 的 sh/bash/zsh 对带引号的首 token 没有任何意见，加上就好。
fn interpreter_token(python: &str) -> String {
    if cfg!(windows) || !python.contains(' ') {
        python.to_string()
    } else {
        format!("\"{python}\"")
    }
}

/// 改写 hooks.json 里每一条命令的解释器。
///
/// 写出来的那一行形状是有讲究的，每一处都是实测出来的：
///
/// ```text
/// C:/PROGRA~1/…/python.exe "${CLAUDE_PLUGIN_ROOT}/hooks/agent-avatar-hook.py" ; exit 0
/// └─ 正斜杠、不加引号          └─ 参数加引号（两个 shell 都收）      └─ 安全网
/// ```
///
/// `; exit 0` 不是可选的：脚本路径一旦断了，`python x.py` 的退出码**正好是 2**，
/// 而 2 在 Claude Code 与 Codex 里都表示「拦截」。
///
/// Codex 有自己的 `commandWindows` 覆盖字段，所以 Windows 上写它、POSIX 的 `command` 不动，
/// 一份 hooks.json 服务两个平台。**POSIX 上必须写 `command`** —— 永远写 `commandWindows`
/// 会把好路径放进 macOS 不读的字段，而活着的命令仍是 `/usr/bin/python3`，那在没装 Xcode
/// 命令行工具的 Mac 上是个会弹安装框的占位程序。
fn rewrite_hooks_json(path: &Path, python: &str, harness: &str) -> Result<usize, String> {
    let field = if harness == "codex" && cfg!(windows) { "commandWindows" } else { "command" };
    let raw = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut document: Value = serde_json::from_str(&raw).map_err(|error| format!("{}: {error}", path.display()))?;

    let mut rewritten = 0;
    if let Some(groups) = document.get_mut("hooks").and_then(Value::as_object_mut) {
        for matchers in groups.values_mut() {
            for matcher in matchers.as_array_mut().into_iter().flatten() {
                for hook in matcher.get_mut("hooks").and_then(Value::as_array_mut).into_iter().flatten() {
                    if hook.get("type").and_then(Value::as_str) != Some("command") {
                        continue;
                    }
                    let source = hook.get(field).and_then(Value::as_str)
                        .or_else(|| hook.get("command").and_then(Value::as_str))
                        .unwrap_or("").to_string();
                    // 只换解释器；脚本路径原样保留（含 ${PLUGIN_ROOT} 这类占位符）
                    let tail = match source.trim().split_once(' ') {
                        Some((_, rest)) => rest.trim().to_string(),
                        None => source.trim().to_string(),
                    };
                    let tail = if tail.starts_with('"') { tail } else {
                        match tail.split_once(' ') {
                            Some((first, rest)) => format!("\"{first}\" {rest}"),
                            None => format!("\"{tail}\""),
                        }
                    };
                    hook[field] = Value::String(format!("{} {tail}", interpreter_token(python)));
                    rewritten += 1;
                }
            }
        }
    }
    if rewritten == 0 {
        return Err(format!("hooks.json 里一条命令都没有，布局可能变了：{}", path.display()));
    }
    fs::write(path, serde_json::to_string_pretty(&document)
        .map_err(|error| error.to_string())? + "\n")
        .map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(rewritten)
}

/// dsh 是个 in-process 的 JS 插件，自己去 spawn 一个 python 子进程。
///
/// Windows 上这是五种失败里**最安静**的一种：它把 stderr 设成 ignore，而 `error` 事件只在
/// spawn 本身失败时才触发 —— 而那个应用商店存根是能正常启动的。这里换掉那一行里的默认值；
/// `AGENT_AVATAR_PYTHON` 环境变量仍然优先于它。
fn rewrite_index_mjs(path: &Path, python: &str) -> Result<usize, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let marker = "process.env.AGENT_AVATAR_PYTHON || \"";
    let start = text.find(marker)
        .ok_or_else(|| format!("index.mjs 里找不到解释器那一行，布局可能变了：{}", path.display()))?;
    let value_start = start + marker.len();
    let value_end = value_start + text[value_start..].find('"')
        .ok_or_else(|| format!("index.mjs 里那一行没有收尾的引号：{}", path.display()))?;
    let mut updated = String::with_capacity(text.len() + python.len());
    updated.push_str(&text[..value_start]);
    updated.push_str(python);
    updated.push_str(&text[value_end..]);
    fs::write(path, updated).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(1)
}

// ---------------------------------------------------------------------------
// 冒烟自检
// ---------------------------------------------------------------------------

/// 喂一条真事件进去，看状态文件落不落盘。
///
/// 🔴 **落盘是唯一可接受的证据，退出码不算。** hook 被设计成永远 exit 0（退出码 2 会拦住
/// agent），所以它的退出码说明不了它有没有干活。少拷了 core、解释器不对，两者看起来都是
/// 「悄悄地什么也没发生」—— 这个项目撞过的每一个坑都是这个形状。
fn smoke_test(tree: &Path, harness: &str, python: &Path) -> Result<(), String> {
    let layout = layout(harness);
    let hook = match layout.hook { Some(hook) => hook, None => return Ok(()) };

    let scratch = env::temp_dir().join(format!("agent-avatar-smoke-{harness}"));
    let _ = fs::remove_dir_all(&scratch);
    fs::create_dir_all(&scratch).map_err(|error| format!("{error}"))?;

    let event = format!("{{\"hook_event_name\":\"{}\",\"session_id\":\"install\",\"turn_id\":\"1\"}}",
                        layout.event);
    let mut command = Command::new(python);
    command.arg(joined(&tree.join(harness_relative(harness)), hook))
        .env("TMPDIR", &scratch).env("TEMP", &scratch).env("TMP", &scratch)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| format!("跑不起来自带的解释器：{error}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        let _ = stdin.write_all(event.as_bytes());
    }
    let output = child.wait_with_output().map_err(|error| format!("{error}"))?;

    let landed = scratch.join(layout.state).is_file();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let _ = fs::remove_dir_all(&scratch);
    if landed {
        Ok(())
    } else {
        Err(format!("自检没通过：{harness} 的 hook 没有写出状态文件{}",
                    if stderr.is_empty() { String::new() } else { format!("（{stderr}）") }))
    }
}

/// 插件树在 marketplace 里的相对位置。
fn harness_relative(harness: &str) -> PathBuf {
    PathBuf::from("plugins").join(harness).join("agent-avatar")
}

// ---------------------------------------------------------------------------
// 登记
// ---------------------------------------------------------------------------

/// dsh 的登记块两端的标记。
const DSH_BEGIN: &str = "# >>> agent-avatar (managed) >>>";
const DSH_END: &str = "# <<< agent-avatar (managed) <<<";

fn dsh_patch_file() -> PathBuf {
    harness_home("DSH_HOME", ".dsh").join("cordis.patch.yml")
}

/// 写（或删）dsh 的登记。
///
/// 🔴 五家里**只有这一个**文件是我们自己写的，因为 dsh 根本没有 CLI —— 那个 patch 文件
/// 就是它的安装机制本身。其余四家一律交给它们自己的 CLI。
///
/// 判定「哪一条是我们的」看的是 `id: agent-avatar`，而不是那两行标记：按更早的提示词装过的
/// 机器上，那一段是**手工粘贴**进去的，标记可能根本不在。认不出来的话，重装会叠出第二条，
/// 卸载会报成功却留着一条。
fn edit_dsh_registration(tree: &Path, remove: bool) -> Result<PathBuf, String> {
    let path = dsh_patch_file();
    let existing = fs::read_to_string(&path).unwrap_or_default();
    if !existing.is_empty() {
        let _ = fs::write(path.with_extension("yml.agent-avatar-backup"), &existing);
    }

    let mut kept: Vec<String> = Vec::new();
    let mut item: Vec<String> = Vec::new();
    let mut in_item = false;
    let mut skipping = false;
    let flush = |item: &mut Vec<String>, kept: &mut Vec<String>| {
        if !item.iter().any(|line| line.contains("id: agent-avatar")) {
            kept.append(item);
        }
        item.clear();
    };
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == DSH_BEGIN { flush(&mut item, &mut kept); in_item = false; skipping = true; continue; }
        if trimmed == DSH_END { skipping = false; continue; }
        if skipping { continue; }
        if line.starts_with("- ") {
            flush(&mut item, &mut kept);
            in_item = true;
        } else if in_item && !trimmed.is_empty() && !line.starts_with(' ') && !line.starts_with('\t') {
            flush(&mut item, &mut kept);
            in_item = false;
        }
        if in_item { item.push(line.to_string()); } else { kept.push(line.to_string()); }
    }
    flush(&mut item, &mut kept);
    // 空的 patch 列表写成一个孤零零的 `[]`，留在真条目上面是无效 YAML
    kept.retain(|line| line.trim() != "[]");
    while kept.last().map(|line| line.trim().is_empty()).unwrap_or(false) { kept.pop(); }

    if !remove {
        // 🔴 dsh 把这个字符串当 ESM specifier 去 import，而 Node 会把 `C:/…` 的盘符当成
        // 协议名（ERR_UNSUPPORTED_ESM_URL_SCHEME）。必须是 file:/// URL。
        let entry = tree.join(harness_relative("dsh")).join("index.mjs");
        kept.push(DSH_BEGIN.to_string());
        kept.push("- insert:".to_string());
        kept.push("    - id: agent-avatar".to_string());
        kept.push(format!("      name: {}", file_url(&entry)));
        kept.push(DSH_END.to_string());
    }

    let mut body = kept.join("\n");
    if !body.is_empty() { body.push('\n'); }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("{error}"))?;
    }
    let temporary = path.with_extension("yml.tmp");
    fs::write(&temporary, body).map_err(|error| format!("{}: {error}", temporary.display()))?;
    fs::rename(&temporary, &path).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(path)
}

/// `C:\a\b` -> `file:///C:/a/b`
fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.starts_with('/') { format!("file://{text}") } else { format!("file:///{text}") }
}

/// Hermes 要的是一个 **git 源**。
///
/// 它的 CLI 只认 Git URL / owner-repo / 社区索引，**完全不认本地目录**；而 `file://`
/// 又不支持子路径（指到 `…/plugins/hermes/agent-avatar` 会说 not a git repository）。
/// 所以把那一份单独拷出来、`git init` 成一个只有它自己的小仓库，再用 `file://` 装。
/// 实测通过：doctor 报 `OK … 10 hook(s)`。
///
/// 不在打包里直接放 `.git` 是因为资源 glob 对点目录不可靠；而走这条路的机器必然有 git ——
/// Hermes 自己就是用 git 装插件的。
fn hermes_repo(repo: &Path, tree: &Path) -> Result<PathBuf, String> {
    let repo = repo.to_path_buf();
    if repo.exists() {
        fs::remove_dir_all(&repo).map_err(|error| format!("{error}"))?;
    }
    copy_tree(&tree.join(harness_relative("hermes")), &repo).map_err(|error| format!("{error}"))?;

    let git = Path::new("git");
    let repo_text = repo.to_string_lossy().to_string();
    run(git, &["-C", &repo_text, "init", "-q"])?;
    run(git, &["-C", &repo_text, "add", "-A"])?;
    run(git, &["-C", &repo_text, "-c", "user.email=connector@agent-avatar",
               "-c", "user.name=Agent Avatar", "commit", "-qm", "bundled connector"])?;
    Ok(repo)
}

// ---------------------------------------------------------------------------
// 装机记录
// ---------------------------------------------------------------------------

/// 删一棵目录树，路上把只读属性清掉。
///
/// Windows 上 git clone 出来的 pack 文件带只读属性，`remove_dir_all` 会直接撞 Access denied。
/// 这是 Hermes 自己的卸载卡住的原因，所以这里得比标准库多做一步。
fn force_remove_dir(path: &Path) {
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_dir() {
                force_remove_dir(&child);
            } else {
                if let Ok(metadata) = child.metadata() {
                    let mut permissions = metadata.permissions();
                    #[allow(clippy::permissions_set_readonly_false)]
                    permissions.set_readonly(false);
                    let _ = fs::set_permissions(&child, permissions);
                }
                let _ = fs::remove_file(&child);
            }
        }
    }
    let _ = fs::remove_dir(path);
}

/// 记下**验证过什么**，放在状态文件旁边。
///
/// 界面靠它区分「刚装完，当然还没上报」和「装了很久还是没上报」—— 后者才是故障。
fn record_install(harness: &str, source: &Path, python: &Path, version: &str) -> Result<(), String> {
    let record = json!({
        "at": rfc3339(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)),
        "harness": harness,
        "connector_version": version,
        "python": python.to_string_lossy(),
        "smoke_test": "passed",
        "source": source.to_string_lossy(),
        "installed_by": "app",
    });
    let path = env::temp_dir().join(format!("agent-avatar-install.{harness}.json"));
    fs::write(&path, serde_json::to_string(&record).map_err(|error| error.to_string())?)
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// 打包进来的那份 core 里写的版本号 —— 它会被写进每一次状态快照。
fn bundled_version(tree: &Path) -> String {
    let core = joined(&tree.join(harness_relative("claude-code")), "hooks/state_machine.py");
    fs::read_to_string(core).ok()
        .and_then(|text| text.lines()
            .find_map(|line| line.strip_prefix("CONNECTOR_VERSION = \"")
                .and_then(|rest| rest.split('"').next())
                .map(str::to_owned)))
        .unwrap_or_else(|| "unknown".to_string())
}

// ---------------------------------------------------------------------------
// 对外的两条命令
// ---------------------------------------------------------------------------

/// 装 —— **不碰 tauri**，因为这一段才是要被真机测试驱动的部分。
///
/// 命令那一层只负责算出「打包的树在哪、解释器在哪、hermes 的临时仓库放哪」，
/// 剩下的都在这里：本地化 → 自检 → 交给 harness 自己的 CLI 登记 → 记一笔装机记录。
pub(crate) fn install_into(tree: &Path, python: &Path, harness: &str, hermes_dir: &Path)
                           -> Result<Value, String> {
    let plugin = tree.join(harness_relative(harness));
    let version = bundled_version(tree);

    // 1) 本地化 —— 必须在登记**之前**：Codex 的 `plugin add` 会把插件拷进自己的缓存，
    //    先登记再改文件的话，改的是没人加载的那一份。
    let command_python = command_line_path(python);
    if let Some(config) = layout(harness).config {
        let path = joined(&plugin, config);
        if config.ends_with(".mjs") {
            rewrite_index_mjs(&path, &command_python)?;
        } else {
            rewrite_hooks_json(&path, &command_python, harness)?;
        }
    }

    // 2) 自检：这台机器上真的跑得起来。**落盘是唯一可接受的证据**（见 `smoke_test`）。
    smoke_test(tree, harness, python)?;

    // 3) 登记 —— 交给它自己的 CLI（dsh 除外，它根本没有）
    let tree_text = tree.to_string_lossy().to_string();
    match harness {
        "dsh" => { edit_dsh_registration(tree, false)?; }
        "hermes" => {
            let cli = resolve_cli(harness).ok_or_else(|| "找不到 hermes 的命令行程序".to_string())?;
            let repo = hermes_repo(hermes_dir, tree)?;
            // 已经装着时 `install` 会拒绝；`--force` 才是重装
            run(&cli, &["plugins", "install", &file_url(&repo), "--enable", "--force"])?;
        }
        _ => {
            let cli = resolve_cli(harness)
                .ok_or_else(|| format!("找不到 {harness} 的命令行程序"))?;
            let (add, _) = plugin_verbs(&cli, harness);
            // 同名 marketplace 已登记时 `add` 会报「已存在」，那不是失败 —— 先撤再加。
            // marketplace 那两个动词三家一致（实测），不同的只有插件本身那两个。
            let _ = run(&cli, &["plugin", "marketplace", "remove", "agent-avatar"]);
            run(&cli, &["plugin", "marketplace", "add", &tree_text])?;
            run(&cli, &["plugin", &add, "agent-avatar@agent-avatar"])?;
        }
    }

    record_install(harness, &plugin, python, &version)?;
    Ok(json!({ "harness": harness, "version": version, "source": plugin.to_string_lossy() }))
}

/// 卸 —— 同样不碰 tauri。
pub(crate) fn uninstall_from(tree: &Path, harness: &str) -> Result<Value, String> {
    match harness {
        "dsh" => { edit_dsh_registration(tree, true)?; }
        "hermes" => {
            let cli = resolve_cli(harness).ok_or_else(|| "找不到 hermes 的命令行程序".to_string())?;
            // 🔴 先 disable 再 remove。`remove` 单独跑会把条目留在 config.yaml 的
            // plugins.enabled 里，于是列表说启用、实际加载不到 —— 最难查的那种状态。
            let _ = run(&cli, &["plugins", "disable", "agent-avatar"]);
            let removed = run(&cli, &["plugins", "remove", "agent-avatar"]);

            // 🔴 **Windows 上它只做一半。** 它先把插件目录改名成 `.agent-avatar.remove-xxxx`
            // 再删，而删那一步会撞上 `[WinError 5] Access is denied` —— 目录是 git clone 出来的，
            // pack 文件带只读属性。于是留下一个改了名的残骸，`plugins list` 里那条也还在。
            // 提示词那一版是交代用户自己去收尾；app 这一版必须自己收，否则「卸载」这个按钮
            // 会以一个用户看不懂的报错收场，而且残骸永远留在那儿。
            //
            // 只动 hermes 自己刚造出来又丢下的那个目录，名字是钉死的。
            let mut swept = false;
            for root in hermes_homes() {
                let plugins = root.join("plugins");
                if let Ok(entries) = fs::read_dir(&plugins) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name == "agent-avatar" || name.starts_with(".agent-avatar.remove-") {
                            force_remove_dir(&entry.path());
                            swept = true;
                        }
                    }
                }
            }
            // 判据是**界面看到的那条**，不是命令的退出码：残骸清掉之后它就该是「没装」。
            if crate::connectors::is_installed(harness) {
                return Err(match removed {
                    Err(error) => error,
                    Ok(_) => format!("hermes 说卸掉了，但{}还在",
                                     if swept { "残骸清理后它" } else { "插件目录" }),
                });
            }
        }
        _ => {
            let cli = resolve_cli(harness)
                .ok_or_else(|| format!("找不到 {harness} 的命令行程序"))?;
            // 🔴 用**全名**。短名在 WorkBuddy 上直接失败（`Marketplace undefined is not
            // found.`）而插件原样留着 —— 那次看起来成功，是下一步删 marketplace 时顺带
            // 带走的，靠副作用卸载迟早会漏。
            let (_, remove) = plugin_verbs(&cli, harness);
            run(&cli, &["plugin", &remove, "agent-avatar@agent-avatar"])?;
            let _ = run(&cli, &["plugin", "marketplace", "remove", "agent-avatar"]);
        }
    }
    // 装机记录跟着走：留着它的话，界面会把「刚装好，等新会话」说给一个已经卸载的用户听
    let _ = fs::remove_file(env::temp_dir().join(format!("agent-avatar-install.{harness}.json")));
    Ok(json!({ "harness": harness }))
}

#[tauri::command(async)]
pub fn install_connector(app: tauri::AppHandle, harness: String) -> Result<Value, String> {
    if !HARNESSES.contains(&harness.as_str()) {
        return Err(format!("不认得的 harness：{harness}"));
    }
    let (tree, python) = lay_out_tree(&app)?;
    let hermes_dir = working_root(&app)?.join("hermes-repo");
    install_into(&tree, &python, &harness, &hermes_dir)
}

/// 这一家要不要重铺一遍。
///
/// 两种「不要」都很重要：**版本相同**时重装等于每次打开接入页面都去跑五家的 CLI；
/// **读不到装机记录**时那多半是更早的装法留下的，能用就别碰 —— 我们没有证据说它旧了。
fn needs_refresh(installed: Option<&str>, bundled: &str) -> bool {
    matches!(installed, Some(version) if version != bundled)
}

/// app 自己的版本号，和它**自带的** connector 版本号。
///
/// 两个都要报，因为它们回答的是不同的问题：前者是用户在关于里看到、报 bug 时会贴的那个；
/// 后者是「harness 里现在跑的是哪一版观察者」。打包之后两者是绑在一起发布的，
/// 但仍然不是同一个数字 —— connector 的版本跟着状态文件的格式走，app 的跟着发布走。
/// 同一件事，但**不需要一个跑起来的 app** —— 给卸载器用。
///
/// 🔴 用户删掉这个 app 的那一刻，正是这些登记最该被收回的时刻，而那时 GUI 已经不在了。
/// NSIS 的卸载脚本可以在删文件之前调 `agent-avatar.exe --remove-connectors`；
/// 便携版的用户也可以自己跑一次。
///
/// 卸载那条路径不需要连接器树（dsh 那一段是按 `id: agent-avatar` 认的，与树在哪无关），
/// 所以这里不去解析资源目录 —— 那正是 app 已经半删掉时最可能失败的一步。
pub fn remove_all_headless() -> String {
    let mut removed = Vec::new();
    let mut failed = Vec::new();
    for harness in HARNESSES {
        if !crate::connectors::is_installed(harness) { continue; }
        match uninstall_from(Path::new(""), harness) {
            Ok(_) => removed.push(harness.to_string()),
            Err(error) => failed.push(format!("{harness}: {error}")),
        }
    }
    let mut report = if removed.is_empty() {
        "no connectors were installed".to_string()
    } else {
        format!("removed: {}", removed.join(", "))
    };
    for line in &failed {
        report.push_str(&format!("\ncould not remove {line}"));
    }
    report
}

/// app 的数据目录，**不经过 AppHandle** —— 无界面卸载那条路上没有一个跑起来的 app。
///
/// 口径抄的是 Tauri 自己的 `app_data_dir()`（`dirs::data_dir()/<identifier>`）：
/// Windows 是 `%APPDATA%`（Roaming），macOS 是 `~/Library/Application Support`，
/// 其余按 XDG。为一个路径引一整个 crate 不划算，但**这两处口径必须一致** ——
/// 不一致的话卸载会去删一个空目录，而真正占着 21 MB 的那份留在原地。
fn app_data_dir() -> PathBuf {
    let base = if cfg!(windows) {
        env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| joined(&home(), "AppData/Roaming"))
    } else if cfg!(target_os = "macos") {
        joined(&home(), "Library/Application Support")
    } else {
        env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|_| joined(&home(), ".local/share"))
    };
    base.join(APP_IDENTIFIER)
}

/// `--uninstall` 干的事：收回连接器 + 删掉**我们自己的**那份缓存，然后**如实报告剩下什么**。
///
/// 🔴 **不碰 `models/`。** 那是用户自己导入的 Live2D 模型（这台机器上 266 MB），是他的内容，
/// 不是我们的缓存。卸载器顺手删掉用户内容是一种很容易被原谅、但不该犯的错 —— 所以这里
/// 只说它在哪、多大，删不删由他决定。`config.json` 同理：几 KB，留着也不碍事，
/// 而重装之后他的设置还在。
///
/// 这条路径**不解析资源目录**（理由同 `remove_all_headless`：app 可能已经删了一半），
/// 数据目录则是照 Tauri 的规则自己算的 —— 那时候已经没有 AppHandle 可用了。
pub fn uninstall_everything_of_ours(purge: bool) -> String {
    let mut report = remove_all_headless();
    let data = app_data_dir();

    // 我们自己的缓存无论如何都删：21 MB 的解释器副本，留着没有任何意义
    let ours = data.join("connectors");
    if ours.is_dir() {
        force_remove_dir(&ours);
        report.push_str(&format!("\nremoved {}", ours.display()));
    }

    // 设置和模型是**用户的东西**。默认留着并说清它们在哪、多大；只有他明确选了才删。
    let mut listed = Vec::new();
    for (name, label) in [("models", "models"), ("config.json", "settings")] {
        let path = data.join(name);
        if !path.exists() { continue; }
        let size = directory_size(&path).map(|bytes| format!(", {}", human_size(bytes))).unwrap_or_default();
        if purge {
            force_remove_dir(&path);
            let _ = fs::remove_file(&path);          // config.json 是文件，上面那个只删目录
            listed.push(format!("  removed {} ({label}{size})", path.display()));
        } else {
            listed.push(format!("  {} ({label}{size})", path.display()));
        }
    }
    if !listed.is_empty() {
        report.push_str(if purge { "\nalso removed:\n" } else {
            "\nleft alone — run with --purge, or delete these yourself:\n"
        });
        report.push_str(&listed.join("\n"));
    }
    // 目录空了就把它也收掉，别留一个空壳
    if purge { let _ = fs::remove_dir(&data); }
    report
}

/// 体积说给人看：几 KB 的设置文件写成「0 MB」只会让人以为读错了。
fn human_size(bytes: u64) -> String {
    if bytes >= 1_048_576 {
        format!("{:.0} MB", bytes as f64 / 1_048_576.0)
    } else {
        format!("{:.0} KB", (bytes as f64 / 1024.0).max(1.0))
    }
}

/// 目录大小，用来把「剩下什么」说具体。算不出来就不说数字。
fn directory_size(path: &Path) -> Option<u64> {
    let metadata = path.metadata().ok()?;
    if metadata.is_file() { return Some(metadata.len()); }
    let mut total = 0;
    for entry in fs::read_dir(path).ok()?.flatten() {
        total += directory_size(&entry.path()).unwrap_or(0);
    }
    Some(total)
}

/// 把我们放进**别人应用里**的东西全部取回来。
///
/// 🔴 删掉这个 app 并不会带走它们。五家 harness 的配置里仍然登记着 agent-avatar，而那些
/// hook 命令行指向一个已经不存在的解释器 —— `plugin list` 里还挂着它，每次开会话都会去启动
/// 一个不存在的程序。那是**留在别人应用里的垃圾**，而用户没有理由知道要去哪清。
///
/// 一家失败不打断其余：卸载是善后，能收回多少收回多少，剩下的照实说。
#[tauri::command(async)]
pub fn remove_all_connectors(app: tauri::AppHandle) -> Value {
    let tree = working_root(&app).unwrap_or_default();
    let mut removed = Vec::new();
    let mut failed = Vec::new();
    for harness in HARNESSES {
        if !crate::connectors::is_installed(harness) { continue; }
        match uninstall_from(&tree, harness) {
            Ok(_) => removed.push(json!(harness)),
            Err(error) => failed.push(json!({ "harness": harness, "error": error })),
        }
    }
    json!({ "removed": removed, "failed": failed })
}

#[tauri::command(async)]
pub fn app_versions(app: tauri::AppHandle) -> Value {
    let connector = bundled(&app).map(|(tree, _)| bundled_version(&tree)).ok();
    json!({
        "app": app.package_info().version.to_string(),
        "connector": connector,
    })
}

/// 把已经装着的那几家**对齐到 app 自带的这一版**。
///
/// 🔴 connector 随 app 一起发布，所以 app 一升级，五家里装着的就都是上一版了。没有这一步，
/// 打包带来的「永远同版本」只是句空话：文件是新的，harness 里跑的还是旧的。
///
/// 只在**确实不同**的时候动手（正常情况一次 CLI 都不会调），而且失败不打断别家 ——
/// 一家的 CLI 出问题不该让另外四家也停在旧版。
///
/// 顺带，这一步是「升级后没连上」那一档能被看见的**前提**：重装写下新的装机记录之后，
/// 升级前那个旧状态文件就比这次安装旧了，界面才分得出「以前是通的」和「从没通过」。
/// Codex 尤其需要 —— 它按 hook 的内容哈希记信任，一升级就必须重新 /hooks 授信，
/// 而在此之前界面只会说「还没上报过」，把一个用了几周的人说成新手。
#[tauri::command(async)]
pub fn reconcile_connectors(app: tauri::AppHandle) -> Result<Value, String> {
    let (bundle_tree, _) = bundled(&app)?;
    let bundled = bundled_version(&bundle_tree);
    let mut refreshed = Vec::new();
    let mut failed = Vec::new();

    for harness in HARNESSES {
        if !crate::connectors::is_installed(harness) { continue; }
        // 装机记录里记的是**我们装进去的那一版**，而不是它上报的版本 —— 上报要等下一个
        // 会话，而这里要判断的是「文件是不是旧的」。读不到记录时不动它：那多半是更早的
        // 装法留下的，能用就别碰。
        let installed = crate::hermes::install_record(harness)
            .and_then(|record| record.get("connector_version")
                .and_then(Value::as_str).map(str::to_owned));
        if !needs_refresh(installed.as_deref(), &bundled) { continue; }

        match lay_out_tree(&app).and_then(|(tree, python)| {
            let hermes_dir = working_root(&app)?.join("hermes-repo");
            install_into(&tree, &python, harness, &hermes_dir)
        }) {
            Ok(_) => refreshed.push(json!({ "harness": harness, "from": installed, "to": &bundled })),
            Err(error) => failed.push(json!({ "harness": harness, "error": error })),
        }
    }
    Ok(json!({ "version": bundled, "refreshed": refreshed, "failed": failed }))
}

#[tauri::command(async)]
pub fn uninstall_connector(app: tauri::AppHandle, harness: String) -> Result<Value, String> {
    if !HARNESSES.contains(&harness.as_str()) {
        return Err(format!("不认得的 harness：{harness}"));
    }
    // 卸载只有 dsh 用得到这棵树（去掉它那段登记），而那段登记里存的是绝对路径，
    // 删的时候按 `id: agent-avatar` 认，跟树在哪无关。
    let tree = working_root(&app)?;
    uninstall_from(&tree, &harness)
}

#[cfg(test)]
mod tests {
    use super::{command_line_path, edit_dsh_registration, file_url, harness_relative, joined,
                python_relative, rewrite_hooks_json, rewrite_index_mjs, smoke_test};
    use std::{env, fs, path::PathBuf, sync::{Mutex, MutexGuard}};

    /// 🔴 改环境变量的测试必须串行。cargo 默认并行跑，而 `DSH_HOME` 是**进程级**的 ——
    /// 三条测试各自设一遍再还原，交错起来就会有人读到别人的值。
    /// 症状是随机失败（同一份代码，上一轮全绿，这一轮红一条）。
    static ENVIRONMENT: Mutex<()> = Mutex::new(());

    fn with_dsh_home(dir: &PathBuf) -> (MutexGuard<'static, ()>, Option<String>) {
        let guard = ENVIRONMENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = env::var("DSH_HOME").ok();
        env::set_var("DSH_HOME", dir);
        (guard, previous)
    }

    fn restore_dsh_home(previous: Option<String>) {
        match previous {
            Some(value) => env::set_var("DSH_HOME", value),
            None => env::remove_var("DSH_HOME"),
        }
    }

    /// 打包产物在不在（`connectors/build-bundle.sh` + `fetch-python.sh` 的输出）。
    /// 没构建过就跳过那几条 —— 它们测的是产物本身，不是代码。
    fn bundle() -> Option<(PathBuf, PathBuf)> {
        let root = joined(&PathBuf::from(env!("CARGO_MANIFEST_DIR")), "resources/connectors");
        let tree = root.join("marketplace");
        let python = joined(&root, python_relative());
        if tree.is_dir() && python.is_file() { Some((tree, python)) } else { None }
    }

    /// 🔴 这条是整个打包方案的地基：**app 自带的树 + app 自带的解释器，在这台机器上真的能把
    /// 状态文件写出来**。少拷一个 core 模块、解释器缺一个标准库模块，两者在真实注册里都是
    /// 静默的（hook 被跳过，形象一直不动）—— 只有喂一条真事件才看得见。
    #[test]
    fn the_bundled_tree_and_interpreter_actually_produce_a_state_file() {
        let (tree, python) = match bundle() { Some(pair) => pair, None => return };
        for harness in ["claude-code", "codex", "workbuddy", "dsh"] {
            smoke_test(&tree, harness, &python)
                .unwrap_or_else(|error| panic!("{harness}: {error}"));
        }
    }

    /// Windows 上解释器那一段**不能有空格、不能有反斜杠**：不能加引号（PowerShell 会把带引号
    /// 的首 token 当字符串表达式），而 Claude Code 在 Windows 上默认用 Git Bash，反斜杠会被
    /// 当转义。app 装在 `C:\Program Files\…` 下正好带空格，所以这条不是假设性的。
    #[test]
    fn the_interpreter_path_is_expressible_on_a_command_line() {
        let plain = command_line_path(&PathBuf::from("C:/Python314/python.exe"));
        assert_eq!(plain, "C:/Python314/python.exe");
        assert!(!command_line_path(&PathBuf::from(r"C:\Python314\python.exe")).contains('\\'));

        #[cfg(windows)]
        {
            // 真实存在的带空格路径才拿得到 8.3 短名，所以用系统自带的那个
            let spaced = PathBuf::from(env::var("ProgramFiles").unwrap_or_else(|_| "C:/Program Files".into()));
            if spaced.is_dir() {
                let converted = command_line_path(&spaced);
                assert!(!converted.contains(' '), "带空格的路径没能转成短路径：{converted}");
            }
        }
    }

    /// dsh 把这个字符串当 ESM specifier 去 import，而 Node 会把 `C:/…` 的盘符当成协议名
    /// （ERR_UNSUPPORTED_ESM_URL_SCHEME）。必须是 file:/// URL。
    #[test]
    fn the_dsh_entry_is_a_url_node_can_import() {
        assert_eq!(file_url(&PathBuf::from("C:/a/b/index.mjs")), "file:///C:/a/b/index.mjs");
        assert_eq!(file_url(&PathBuf::from("/a/b/index.mjs")), "file:///a/b/index.mjs");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("agent-avatar-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 本地化只换解释器，**其余原样保留** —— 尤其是 `${PLUGIN_ROOT}` 这类占位符和末尾的
    /// `; exit 0`。那个 `; exit 0` 不是装饰：脚本路径一旦断了，`python x.py` 的退出码正好是
    /// 2，而 2 在 Claude Code 与 Codex 里都表示「拦截」。
    #[test]
    fn localisation_replaces_the_interpreter_and_nothing_else() {
        let dir = scratch("hooks");
        let path = dir.join("hooks.json");
        fs::write(&path, r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"python3 ${PLUGIN_ROOT}/hooks/agent-avatar-hook.py ; exit 0"}]}]}}"#).unwrap();

        let count = rewrite_hooks_json(&path, "C:/PROGRA~1/py/python.exe", "claude-code").unwrap();
        assert_eq!(count, 1);
        // 读回来看那个**值**，而不是文件的字面文本 —— 文件里的引号是 JSON 转义过的
        let document: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let command = document["hooks"]["SessionStart"][0]["hooks"][0]["command"].as_str().unwrap();
        assert_eq!(command,
                   "C:/PROGRA~1/py/python.exe \"${PLUGIN_ROOT}/hooks/agent-avatar-hook.py\" ; exit 0");
    }

    /// Codex 有自己的 `commandWindows` 覆盖字段。Windows 上写它、POSIX 的 `command` 不动，
    /// 一份 hooks.json 服务两个平台。**反过来是个陷阱**：永远写 `commandWindows` 会把好路径
    /// 放进 macOS 不读的字段，而活着的命令仍是 `/usr/bin/python3` —— 那在没装 Xcode 命令行
    /// 工具的 Mac 上是个会弹安装框的占位程序。
    #[test]
    fn codex_gets_the_field_this_platform_actually_reads() {
        let dir = scratch("codex-hooks");
        let path = dir.join("hooks.json");
        let original = r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/usr/bin/python3 ${PLUGIN_ROOT}/scripts/agent-avatar-hook.py ; exit 0"}]}]}}"#;
        fs::write(&path, original).unwrap();
        rewrite_hooks_json(&path, "C:/py/python.exe", "codex").unwrap();
        let written = fs::read_to_string(&path).unwrap();
        if cfg!(windows) {
            assert!(written.contains("commandWindows"));
            assert!(written.contains("/usr/bin/python3"), "POSIX 那条要原样留着：{written}");
        } else {
            assert!(!written.contains("commandWindows"));
            assert!(!written.contains("/usr/bin/python3"));
        }
    }

    #[test]
    fn the_dsh_plugin_learns_where_the_interpreter_is() {
        let dir = scratch("dsh-index");
        let path = dir.join("index.mjs");
        fs::write(&path, "const py = process.env.AGENT_AVATAR_PYTHON || \"python3\";\n").unwrap();
        rewrite_index_mjs(&path, "C:/py/python.exe").unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("AGENT_AVATAR_PYTHON || \"C:/py/python.exe\""), "{written}");
    }

    /// 这个文件是**用户的**，我们只往里加一条。写两次不能叠出两条，删掉之后用户自己的条目
    /// 要一字不差地还在。
    #[test]
    fn registering_dsh_twice_leaves_one_entry_and_keeps_theirs() {
        let dir = scratch("dsh-home");
        let (_guard, previous) = with_dsh_home(&dir);

        let theirs = "- insert:\n    - id: their-plugin\n      name: file:///theirs/index.mjs\n";
        fs::write(dir.join("cordis.patch.yml"), theirs).unwrap();

        let tree = PathBuf::from("/bundle/marketplace");
        edit_dsh_registration(&tree, false).unwrap();
        edit_dsh_registration(&tree, false).unwrap();
        let body = fs::read_to_string(dir.join("cordis.patch.yml")).unwrap();
        assert_eq!(body.matches("id: agent-avatar").count(), 1, "{body}");
        assert!(body.contains("their-plugin"));
        assert!(body.contains("file:///"), "{body}");

        edit_dsh_registration(&tree, true).unwrap();
        let body = fs::read_to_string(dir.join("cordis.patch.yml")).unwrap();
        assert!(!body.contains("agent-avatar"), "{body}");
        assert_eq!(body.trim(), theirs.trim());

        restore_dsh_home(previous);
    }

    /// 按更早那版提示词装过的机器上，那一段是**手工粘贴**进去的 —— 两行标记可能根本不在。
    /// 认不出来的话，重装叠出第二条，卸载报成功却留着一条。
    #[test]
    fn an_entry_pasted_by_hand_is_still_recognised_as_ours() {
        let dir = scratch("dsh-legacy");
        let (_guard, previous) = with_dsh_home(&dir);
        fs::write(dir.join("cordis.patch.yml"),
                  "- insert:\n    - id: agent-avatar\n      name: file:///old/index.mjs\n").unwrap();

        edit_dsh_registration(&PathBuf::from("/bundle/marketplace"), false).unwrap();
        let body = fs::read_to_string(dir.join("cordis.patch.yml")).unwrap();
        assert_eq!(body.matches("id: agent-avatar").count(), 1, "{body}");
        assert!(!body.contains("/old/index.mjs"), "旧的那条要被替掉，不是并存：{body}");

        restore_dsh_home(previous);
    }

    /// 空列表写成一个孤零零的 `[]`，留在真条目上面是无效 YAML —— dsh 会整个停止解析。
    #[test]
    fn an_empty_list_marker_does_not_survive_next_to_a_real_entry() {
        let dir = scratch("dsh-empty");
        let (_guard, previous) = with_dsh_home(&dir);
        fs::write(dir.join("cordis.patch.yml"), "[]\n").unwrap();
        edit_dsh_registration(&PathBuf::from("/bundle/marketplace"), false).unwrap();
        let body = fs::read_to_string(dir.join("cordis.patch.yml")).unwrap();
        assert!(!body.contains("[]"), "{body}");
        restore_dsh_home(previous);
    }

    /// 真机安装 —— **默认不跑**，要 `AGENT_AVATAR_LIVE_INSTALL=<harness>` 才会启动。
    ///
    /// 它会真的调那家 harness 的 CLI 去装、去卸，所以会改这台机器上的配置。放在测试里而不是
    /// 手工脚本里，是因为它要验的东西只有代码内部看得见：本地化写进去的那一行、自检落盘、
    /// 以及登记之后 harness 自己的账本认不认。
    ///
    /// 用法：`AGENT_AVATAR_LIVE_INSTALL=claude-code cargo test live_install -- --nocapture`
    #[test]
    fn live_install_and_uninstall_on_this_machine() {
        let harness = match env::var("AGENT_AVATAR_LIVE_INSTALL") { Ok(value) => value, Err(_) => return };
        let (bundle, bundled_python) = bundle().expect("先跑 connectors/build-bundle.sh 与 fetch-python.sh");

        // 拷成工作副本再动手 —— 本地化会改写文件，而构建产物应当保持机器无关
        let root = scratch("live-install");
        let tree = root.join("marketplace");
        super::copy_tree(&bundle, &tree).unwrap();
        let python_root = root.join("python");
        super::copy_tree(bundled_python.parent().unwrap(), &python_root).unwrap();
        let python = python_root.join(bundled_python.file_name().unwrap());

        let report = super::install_into(&tree, &python, &harness, &root.join("hermes-repo"))
            .unwrap_or_else(|error| panic!("装 {harness} 失败：{error}"));
        println!("installed: {report}");

        assert!(crate::connectors::is_installed(&harness),
                "{harness} 装完之后界面仍然会说没装 —— 登记那一步没真的生效");

        let record = env::temp_dir().join(format!("agent-avatar-install.{harness}.json"));
        assert!(record.is_file(), "没写装机记录，界面就分不清「刚装好」和「装了很久还不动」");

        // 装完就地留下 —— 用来验最后那一环：真开一个会话，状态文件落不落盘。
        // 那一环 Rust 侧验不了（要真的跑一次 harness），所以留给外面的脚本。
        if env::var("AGENT_AVATAR_LIVE_KEEP").is_ok() {
            println!("left installed on purpose (AGENT_AVATAR_LIVE_KEEP)");
            return;
        }

        super::uninstall_from(&tree, &harness)
            .unwrap_or_else(|error| panic!("卸 {harness} 失败：{error}"));
        assert!(!crate::connectors::is_installed(&harness), "{harness} 卸完界面仍然会说装着");
        assert!(!record.is_file(), "卸完装机记录还在，界面会对已卸载的用户说「刚装好」");
    }

    /// 三家 help 的形状各不相同，解析器要认全 —— 片段是 2026-09-03 从真 CLI 抓的原文。
    ///
    /// 🔴 这条测试存在的理由：我们曾经按 harness 名字写死动词，对 Codex 写成了
    /// `install`/`uninstall`，而它其实是 `add`/`remove`。两个平台都错，很久没人发现，
    /// 因为那段提示词从没在真 CLI 上跑过。
    #[test]
    fn the_verbs_come_from_the_cli_not_from_our_assumptions() {
        use super::subcommands;

        let claude = "Commands:\n  disable [options] [plugin]           Disable an enabled plugin\n  \
                      install [options] <plugin>           Install a plugin\n  \
                      uninstall [options] <plugin>         Uninstall a plugin\n";
        let names = subcommands(claude);
        assert!(names.iter().any(|name| name == "install"), "{names:?}");
        assert!(names.iter().any(|name| name == "uninstall"), "{names:?}");

        // CodeBuddy 用竖线挂别名
        let codebuddy = "Commands:\n  list|ls [options]                    List installed plugins\n  \
                         uninstall|remove [options] <plugin>  Uninstall an installed plugin\n";
        let names = subcommands(codebuddy);
        assert!(names.iter().any(|name| name == "uninstall"), "{names:?}");
        assert!(names.iter().any(|name| name == "remove"), "{names:?}");

        // Hermes 用括号挂别名，而且 Codex 只有 add/remove
        let codex = "Commands:\n  add          Install a plugin from a marketplace\n  \
                     remove (rm, uninstall)  Uninstall a plugin\n";
        let names = subcommands(codex);
        assert!(names.iter().any(|name| name == "add"), "{names:?}");
        assert!(names.iter().any(|name| name == "rm"), "{names:?}");
    }

    /// 判断错的方向不同，代价也不同：多装一次是每次打开页面都跑五家 CLI，
    /// 少装一次是 app 升级了而 harness 里跑的还是旧 connector。
    #[test]
    fn a_connector_is_refreshed_only_when_we_know_it_is_old() {
        use super::needs_refresh;
        assert!(needs_refresh(Some("1.0.0"), "1.1.0"));
        assert!(!needs_refresh(Some("1.1.0"), "1.1.0"));
        // 读不到装机记录 = 更早的装法装的，没有证据说它旧了，别碰
        assert!(!needs_refresh(None, "1.1.0"));
    }

    /// 🔴 Windows 的 verbatim 路径（`\\?\C:\...`）**关闭了路径规范化**：里面的 `/` 不再是
    /// 分隔符。而 `resource_dir()` 返回的正是这种路径 —— 于是 `join("resources/connectors")`
    /// 拼出来的东西根本解析不到，表现是「app 里没有连接器树」，而那个目录明明在。
    ///
    /// 这个坑只在打包后的真 app 里发作：开发和测试里的路径都是我们自己拼的普通路径。
    #[test]
    fn a_relative_path_is_joined_one_segment_at_a_time() {
        let base = PathBuf::from("base");
        assert_eq!(joined(&base, "a/b/c"), base.join("a").join("b").join("c"));
        // 拼出来的东西里不能留下正斜杠
        assert!(!joined(&base, "a/b").to_string_lossy().contains('/'),
                "{}", joined(&base, "a/b").display());
        assert_eq!(joined(&base, "one"), base.join("one"));
        assert_eq!(joined(&base, ""), base);
    }

    /// 🔴 macOS 上解释器住在 `~/Library/Application Support/…` —— **带空格**，而那边没有
    /// 8.3 短路径可退。不加引号的话 shell 会在 `Application` 和 `Support` 之间断开，
    /// 表现还是那个老形状：装好了，形象不动。
    ///
    /// 「不能加引号」是 PowerShell 的毛病，我们一度把它当成了通则。
    #[test]
    fn a_path_with_spaces_is_quoted_where_the_shell_allows_it() {
        use super::interpreter_token;
        assert_eq!(interpreter_token("/usr/bin/python3"), "/usr/bin/python3");
        let spaced = "/Users/x/Library/Application Support/app/python3";
        if cfg!(windows) {
            // Windows 走短路径那条，到这里时已经没有空格了
            assert_eq!(interpreter_token(spaced), spaced);
        } else {
            assert_eq!(interpreter_token(spaced), format!("\"{spaced}\""));
        }
    }

    /// macOS 上 GUI 进程不继承 shell 的 PATH，而 Claude Code / CodeBuddy 都是 npm 全局装的 ——
    /// 只认 PATH 的话，「用户明明装了，app 说找不到」在 mac 上会是默认结果。
    /// 版本管理器（nvm / fnm / volta / asdf）还会把 node 藏在带版本号的目录里。
    #[test]
    #[cfg(not(windows))]
    fn it_looks_where_node_actually_lives_on_posix() {
        use super::node_bin_dirs;
        let dirs = node_bin_dirs();
        let text: Vec<String> = dirs.iter().map(|d| d.to_string_lossy().to_string()).collect();
        for expected in ["/usr/local/bin", "/opt/homebrew/bin", ".volta/bin", ".asdf/shims"] {
            assert!(text.iter().any(|d| d.contains(expected)), "缺 {expected}：{text:?}");
        }
    }

    /// 五家的插件树位置是一张表，改布局就要改它 —— 对不上的症状是「装好了，什么也不发生」。
    #[test]
    fn every_harness_has_a_place_in_the_bundled_tree() {
        let (tree, _) = match bundle() { Some(pair) => pair, None => return };
        for harness in crate::connectors::HARNESSES {
            assert!(tree.join(harness_relative(harness)).is_dir(), "{harness}");
        }
    }
}
