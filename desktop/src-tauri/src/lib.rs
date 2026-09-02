use std::{env, fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}, sync::Mutex, time::{Duration, SystemTime, UNIX_EPOCH}};
use hit_test::{should_ignore, Mode, Region};
use tauri::{Emitter, Manager, window::Color};
use std::sync::OnceLock;
mod hit_test;
mod config;
mod model_clean;
mod platform;
#[cfg(test)]
mod test_support;

/// **面向用户的错误只返回代号，措辞留在前端。**
///
/// 界面语言存在前端（config.json 的 `language`），Rust 侧不知道现在是中文还是英文 ——
/// 原来这些串是中文写死的，英文界面下会突然冒出一句中文（发布前逐条过文案时发现）。
///
/// 形状是 `code` 或 `code|detail`：detail 是要嵌进句子的东西（文件夹名、命令回显），
/// 由前端决定怎么摆。前端见 `src/errors.ts`，那里每个代号都有中英两句；
/// 认不出的代号原样显示，所以漏翻不会变成空白。
pub mod user_error {
    pub const ARCHIVE: &str = "archive";
    pub const NOT_A_FOLDER: &str = "not-a-folder";
    pub const BAD_NAME: &str = "bad-name";
    pub const NO_MODEL3: &str = "no-model3";
    pub const ALREADY_INSTALLED: &str = "already-installed";
    pub const TOO_LARGE: &str = "too-large";
    pub const UNKNOWN_MODEL: &str = "unknown-model";
    pub const DOWNLOAD_FAILED: &str = "download-failed";
    pub const EXTRACT_FAILED: &str = "extract-failed";
    pub const BAD_ARCHIVE: &str = "bad-archive";
    pub const INSTALL_FAILED: &str = "install-failed";
    pub const LOCAL_ZIP_MISSING: &str = "local-zip-missing";
    pub const UNKNOWN_HARNESS: &str = "unknown-harness";

    /// 前端必须逐个有中英文案的那一份清单（`errors.ts` 与它对表，见那边的测试）。
    pub const ALL: [&str; 13] = [ARCHIVE, NOT_A_FOLDER, BAD_NAME, NO_MODEL3, ALREADY_INSTALLED,
        TOO_LARGE, UNKNOWN_MODEL, DOWNLOAD_FAILED, EXTRACT_FAILED, BAD_ARCHIVE, INSTALL_FAILED,
        LOCAL_ZIP_MISSING, UNKNOWN_HARNESS];
}
/// Agent connector 一键接入（下载 / 解压 / 跑各家 install-plugin.sh）。
mod connectors;
/// Hermes 适配层：**可整体摘除**的边界（见 integrations/hermes/README.md）。
/// 删掉这一行与 hermes.rs 后应用仍能跑，前端调不到命令会自动降级为常驻 idle。
/// 唯一的外部牵连：connectors.rs 用 `hermes::last_signal_seconds` 判断 connector 通没通
/// （状态文件的落点由本模块定义），一并摘除时那里的「已连通」要退回成只看目录。
mod hermes;
// static_server 只在 release 分支使用（见下方 #[cfg(not(debug_assertions))]），
// debug 构建下整模块「未使用」但仍需编译与运行其单测，故只在 debug 下静音告警。
#[cfg_attr(debug_assertions, allow(dead_code))]
mod static_server;
const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;
static LOG_WRITE_LOCK: Mutex<()> = Mutex::new(());
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
const HIT_POLL_MS: u64 = 60;
/// 穿透模式下光标停留多久恢复交互。改动需同步 main.ts 里角标提示的秒数。
const DWELL_MS: u128 = 3000;

#[derive(Default)]
struct HitConfig { region: Region, mode: Mode, track_cursor: bool }
fn rotate_log_if_needed(path: &Path, max_bytes: u64) -> std::io::Result<()> {
    if fs::metadata(path).is_ok_and(|metadata| metadata.len() >= max_bytes) {
        let rotated = PathBuf::from(format!("{}.1", path.display()));
        if rotated.exists() { fs::remove_file(&rotated)?; }
        fs::rename(path, rotated)?;
    }
    Ok(())
}
fn append_log_event(path: &Path, event: &str) -> std::io::Result<()> {
    let _guard = LOG_WRITE_LOCK.lock().map_err(|_| std::io::Error::other("log write lock poisoned"))?;
    let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    rotate_log_if_needed(path, LOG_ROTATE_BYTES)?;
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{}", serde_json::json!({ "at": at, "event": event }))?;
    file.flush()
}
fn log_path() -> PathBuf {
    env::var("AGENT_AVATAR_LOG").map(PathBuf::from).unwrap_or_else(|_| env::temp_dir().join("agent-avatar-webview.log"))
}
#[tauri::command]
fn log_event(event: String) {
    let _ = append_log_event(&log_path(), &event);
}
/// 只允许本机回环的 http 地址 —— 把任意 URL 丢给 `open` 等于把命令执行面暴露出去。
fn loopback_url(raw: &str) -> Option<&str> {
    let rest = raw.strip_prefix("http://")?;
    let host = rest.split(['/', ':', '?', '#']).next()?;
    (host == "localhost" || host == "127.0.0.1").then_some(raw)
}

#[tauri::command]
fn open_in_browser(url: String) -> Result<(), String> {
    const LIVE2D_SAMPLE_URL: &str = "https://www.live2d.com/en/learn/sample/momose-hiyori/";
    let url = if url == LIVE2D_SAMPLE_URL { url.as_str() } else {
        loopback_url(&url).ok_or_else(|| "only the Live2D sample page or loopback URLs are allowed".to_owned())?
    };
    platform::open_in_default_browser(url)
}

/// 全局音频采集。两个平台的实现天差地别（Core Audio process tap / WASAPI loopback），
/// 但都收在 `platform` 里，且都只吐 `global-audio-level` 与 `global-audio-error` 两个事件 ——
/// 所以这里看不出平台，前端也看不出。
#[tauri::command]
fn start_global_audio() -> Result<(), String> {
    platform::start_global_audio()
}

#[tauri::command]
fn stop_global_audio() {
    platform::stop_global_audio()
}

/// 打开一个工具窗口（设置 / 画廊）。
///
/// **在 Rust 侧建**：前端建窗口要额外开 `core:webview:allow-create-webview-window` 权限，
/// 而 URL 与尺寸该由应用说了算，不能让网页自由指定 —— 所以这里用**白名单**，不接受任意页面。
/// 画廊原来是丢给系统浏览器打开的，但那样它拿不到 Tauri 命令，也就列不出用户装的模型。
/// 已经开着就聚焦，不重复建 —— 否则连点几次会叠出一摞窗口。
#[tauri::command(async)]
fn open_tool_window(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let (label, page, title, width, height) = match name.as_str() {
        // 标题只给应用名：窗口是哪个语言，Rust 不知道（界面语言存在前端配置里）。
        // 本地化标题由各窗口自己 setTitle —— 原来这里写死中文，英文界面的标题栏里
        // 一直挂着「设置」两个中文字（发布前逐条过文案时发现）。
        "settings" => ("settings", "settings.html", "Agent Avatar", 460.0, 640.0),
        "gallery" => ("gallery", "gallery.html", "Agent Avatar", 960.0, 680.0),
        other => return Err(format!("unknown tool window: {other}")),
    };
    if let Some(window) = app.get_webview_window(label) {
        return bring_to_front(&window);
    }
    // 与主页面同源：dev 走 Vite，release 走内嵌静态服务器（见 setup 里的窗口 URL）。
    let main = app.get_webview_window("main").ok_or("main window is gone")?;
    let url = main.url().map_err(|error| error.to_string())?;
    let target = url.join(page).map_err(|error| error.to_string())?;
    let window = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(target))
        .title(title).inner_size(width, height).min_inner_size(360.0, 420.0)
        .resizable(true).visible(false).build().map_err(|error| error.to_string())?;
    // 创建与复用走同一条可见性/聚焦路径。只 build 就返回时，macOS 首次点击可能只创建窗口，
    // 第二次进入上面的 existing 分支才真正把它带到前台。
    bring_to_front(&window)
}

/// 把工具窗口真正带到最前面。
///
/// 只 `show()` + `set_focus()` 不够：主窗口是 always-on-top 的悬浮窗，而工具窗口不是 ——
/// 从别的应用（浏览器、编辑器）切过来时，设置窗口时不时开在**别人后面**，
/// 用户以为「点了没反应」，其实它就在下面（实机反馈）。
///
/// 做法是**短暂**置顶再撤掉：置顶保证它一定压过当前前台窗口，撤掉是因为一直置顶会挡住
/// 用户想同时看的东西（比如照着文档改设置）。500ms 足够窗口管理器完成上浮。
fn bring_to_front(window: &tauri::WebviewWindow) -> Result<(), String> {
    let _ = window.unminimize();   // 最小化过的窗口 show() 不会自己回来
    window.show().map_err(|error| error.to_string())?;
    window.set_always_on_top(true).map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    let handle = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        let _ = handle.set_always_on_top(false);
    });
    Ok(())
}

#[tauri::command]
fn set_hit_region(state: tauri::State<'_, Mutex<HitConfig>>, x: f64, y: f64, width: f64, height: f64, mode: String, track_cursor: bool) -> Result<(), String> {
    let mut config = state.lock().map_err(|_| "hit config poisoned".to_owned())?;
    config.region = Region { x, y, width, height };
    config.mode = Mode::from_label(&mode);
    config.track_cursor = track_cursor;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{append_log_event, log_path, loopback_url, rotate_log_if_needed};

    /// 注册了命令还不够：`capabilities/default.json` 引的 `allow-skin-commands`（见
    /// `permissions/skin.toml`）是一份**白名单**，漏登记的命令会被 Tauri 直接拒掉。
    ///
    /// 这种漏最难查：前端多半 `.catch()` 兜了底，于是表现不是报错，而是**功能安静地什么都不做**
    /// （实测：新加的 list_connectors 没登记，接入页把五家全显示成「未安装」；
    /// delete_model 从来就没登记过，设置页的删除模型一直是坏的）。
    #[test]
    fn every_registered_command_is_allowed_by_the_capability() {
        let source = include_str!("lib.rs");
        // rsplit：本测试自己的源码里也有这个字符串，而真正的注册在文件末尾的 run() 里
        let handlers = source.rsplit("generate_handler![").next().unwrap()
            .split(']').next().unwrap();
        let registered: Vec<&str> = handlers.split(',')
            .map(|item| item.trim().rsplit("::").next().unwrap_or_default())
            .filter(|name| !name.is_empty())
            .collect();
        let allowed = include_str!("../permissions/skin.toml");
        for command in registered {
            assert!(allowed.contains(&format!("\"{command}\"")),
                    "命令 `{command}` 没登记进 permissions/skin.toml，前端调它会被拒绝");
        }
    }
    use std::{env, fs, path::PathBuf, process, sync::Arc, thread, time::{SystemTime, UNIX_EPOCH}};

    #[test]
    fn loopback_url_accepts_only_local_http() {
        assert!(loopback_url("http://localhost:1420/gallery.html").is_some());
        assert!(loopback_url("http://127.0.0.1:17880/gallery.html").is_some());
        // 交给 `open` 的地址必须限死在回环，否则等于开放任意 URL 执行
        assert!(loopback_url("https://localhost/x").is_none());
        assert!(loopback_url("http://evil.example.com/x").is_none());
        assert!(loopback_url("http://127.0.0.1.evil.com/x").is_none());
        assert!(loopback_url("file:///etc/passwd").is_none());
        assert!(loopback_url("").is_none());
    }

    /// 不用 `env::set_var` 走 `log_event`：标准库明言「多线程程序里唯一可靠的做法是根本不用
    /// set_var/remove_var」，而同进程其它测试会经 `to_socket_addrs()` 读环境（DNS），
    /// 组合起来是 UB —— 实测偶发 1/N 失败。路径解析已抽成 `log_path()`，这里直测写入行为。
    #[test]
    fn append_log_event_writes_one_readable_json_line_per_event() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = env::temp_dir().join(format!("agent-avatar-log-{}-{nonce}.jsonl", process::id()));
        append_log_event(&path, "boot:\"start\"").unwrap();
        let line = fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(value["event"], "boot:\"start\"");
        assert!(value["at"].as_u64().is_some());
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn log_path_falls_back_to_the_documented_default() {
        // 只读不写环境：读是安全的，写才是 UB。
        if env::var("AGENT_AVATAR_LOG").is_err() {
            // 原来这里比的是 `PathBuf::from("/tmp/...")` —— 两边同一个字面量，
            // 恒等成立，跨平台跑也永远绿，等于没有断言。改成分别验「落在系统临时目录下」
            // 与「文件名对」，这才是这条默认值真正的两个约定。
            let path = log_path();
            assert!(path.starts_with(env::temp_dir()), "{path:?} 不在系统临时目录下");
            assert_eq!(path.file_name().unwrap(), "agent-avatar-webview.log");
        }
    }
    #[test]
    fn rotates_log_at_limit_and_starts_a_new_log() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = env::temp_dir().join(format!("agent-avatar-rotate-{}-{nonce}.jsonl", process::id()));
        fs::write(&path, b"1234").unwrap();
        rotate_log_if_needed(&path, 4).unwrap();
        let rotated = PathBuf::from(format!("{}.1", path.display()));
        assert_eq!(fs::read(&rotated).unwrap(), b"1234");
        append_log_event(&path, "new").unwrap();
        assert!(fs::read_to_string(&path).unwrap().contains("new"));
        fs::remove_file(path).unwrap();
        fs::remove_file(rotated).unwrap();
    }
    #[test]
    fn rotation_overwrites_previous_backup() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = env::temp_dir().join(format!("agent-avatar-overwrite-{}-{nonce}.jsonl", process::id()));
        let rotated = PathBuf::from(format!("{}.1", path.display()));
        fs::write(&path, b"current").unwrap();
        fs::write(&rotated, b"old backup").unwrap();
        rotate_log_if_needed(&path, 7).unwrap();
        assert_eq!(fs::read(&rotated).unwrap(), b"current");
        assert!(!path.exists());
        fs::remove_file(rotated).unwrap();
    }
    #[test]
    fn concurrent_log_writes_remain_complete_json_lines() {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = Arc::new(env::temp_dir().join(format!("agent-avatar-concurrent-{}-{nonce}.jsonl", process::id())));
        let writers: Vec<_> = (0..32).map(|index| {
            let path = Arc::clone(&path);
            thread::spawn(move || append_log_event(&path, &format!("event-{index}")).unwrap())
        }).collect();
        for writer in writers { writer.join().unwrap(); }
        let lines: Vec<_> = fs::read_to_string(path.as_ref()).unwrap().lines().map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()).collect();
        assert_eq!(lines.len(), 32);
        fs::remove_file(path.as_ref()).unwrap();
    }
}
/// 轮询全局光标位置，决定窗口是否穿透。穿透期间网页收不到事件，故必须在 Rust 侧做。
fn spawn_hit_test(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut inside_since: Option<std::time::Instant> = None;
        let mut applied: Option<bool> = None;
        // 窗口句柄与状态句柄在循环外取一次：原来每 tick 都做一次按字符串查表 + Arc 克隆。
        let mut window = None;
        // 缩放系数只在跨显示器时变，没必要每 tick 问一次系统；定期刷新即可。
        let mut scale = 1.0_f64;
        let mut scale_checked = std::time::Instant::now() - Duration::from_secs(10);
        // 光标没动时可以跳过其余系统调用与 emit —— 桌宠常驻，光标静止是常态。
        let mut last_cursor: Option<(f64, f64)> = None;
        let mut last_inside = false;

        loop {
            std::thread::sleep(Duration::from_millis(HIT_POLL_MS));
            if window.is_none() { window = app.get_webview_window("main"); }
            let Some(handle) = window.as_ref() else { continue };
            let config = match app.state::<Mutex<HitConfig>>().lock() {
                Ok(guard) => (guard.region, guard.mode, guard.track_cursor),
                Err(_) => continue,
            };
            let Ok(cursor) = handle.cursor_position() else { window = None; continue };

            let moved = last_cursor != Some((cursor.x, cursor.y));
            if moved {
                if scale_checked.elapsed() >= Duration::from_secs(2) {
                    if let Ok(current) = handle.scale_factor() { scale = current; }
                    scale_checked = std::time::Instant::now();
                }
                let Ok(position) = handle.outer_position() else { continue };
                let (relative_x, relative_y) = ((cursor.x - position.x as f64) / scale, (cursor.y - position.y as f64) / scale);
                last_inside = config.0.contains(relative_x, relative_y);
                last_cursor = Some((cursor.x, cursor.y));
                // 眼睛跟随复用这条轮询：光标在窗口外也要上报，否则人物只会盯着自己身上
                if config.2 {
                    if let Some(app) = APP_HANDLE.get() {
                        let _ = app.emit("cursor-position", (relative_x, relative_y));
                    }
                }
            }
            let inside = last_inside;

            match (inside, inside_since) {
                (true, None) => inside_since = Some(std::time::Instant::now()),
                (false, _) => inside_since = None,
                _ => {}
            }
            // 停留时长只看时间，不需要系统调用，故光标静止时仍能正确翻转
            let dwell = inside_since.map_or(0, |since| since.elapsed().as_millis());
            let ignore = should_ignore(config.1, inside, dwell, DWELL_MS);
            if applied != Some(ignore) {
                let _ = handle.set_ignore_cursor_events(ignore);
                applied = Some(ignore);
                // 记下每一次翻转。**这是「第一下点了没反应」唯一可查的证据** ——
                // 穿透是窗口级开关，关掉期间网页层收不到任何事件，所以只看前端日志
                // 永远只能看到「什么都没发生」。把翻转时刻记下来，就能和前端的
                // `input:pointerdown` 对时间：点击落在翻转之前 = 撞上了 60ms 轮询窗口期
                //（HIT_POLL_MS），落在之后却没有 pointerdown = 另一回事（系统吞掉了）。
                append_log_event(&log_path(), &serde_json::json!({
                    "event": "hit:ignore-cursor",
                    "ignore": ignore,
                    "inside": inside,
                    "dwellMs": dwell,
                    "mode": if config.1 == Mode::ClickThrough { "through" } else { "normal" },
                }).to_string()).ok();
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| { if let Some(window) = app.get_webview_window("main") { let _ = window.set_focus(); } }))
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());
            #[cfg(debug_assertions)]
            let url = tauri::WebviewUrl::App("index.html".into());
            #[cfg(not(debug_assertions))]
            let url = {
                let preferred = env::var("AGENT_AVATAR_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(static_server::DEFAULT_PORT);
                let server = static_server::StaticServer::start(app.handle().clone(), preferred)?;
                let query = env::var("AGENT_AVATAR_QUERY").ok().filter(|value| !value.is_empty()).map(|value| format!("?{}", value.trim_start_matches('?'))).unwrap_or_default();
                let url = format!("http://127.0.0.1:{}/index.html{query}", server.port).parse().expect("valid loopback URL");
                app.manage(server);
                tauri::WebviewUrl::External(url)
            };
            let window = tauri::WebviewWindowBuilder::new(app, "main", url).title("Agent Avatar").inner_size(340.0, 440.0).resizable(false).decorations(false).transparent(true).background_color(Color(0, 0, 0, 0)).always_on_top(true).shadow(false).center().build()?;
            // Reapply transparency to the created WKWebView instance. WRY's runtime path sets
            // drawsBackground on the instance in addition to the builder-time configuration.
            //
            // **这是 macOS/WKWebView 专属的补丁，不是 Windows 透明的开关。**
            // Windows 走的是 WebView2 + DirectComposition 的逐像素 alpha，透明由上面
            // builder 的 `.transparent(true)` + `background_color(0,0,0,0)` 就已经成立
            //（WP-S 实测：84% 像素全透明、无白边、无幽灵标题栏）。这一行在 Windows 上是空操作，
            // 留着是因为它对 macOS 必要 —— 以后调 Windows 透明时**不要从这里下手**。
            window.set_background_color(Some(Color(0, 0, 0, 0)))?;
            app.manage(Mutex::new(HitConfig::default()));
            spawn_hit_test(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![log_event, hermes::read_semantic_state, hermes::discover_audio_endpoint, config::read_config, config::write_config, config::open_models_dir, config::install_model, config::delete_model, config::list_installed_models, config::list_model_issues, connectors::list_connectors, connectors::install_connector, connectors::uninstall_connector, open_tool_window, set_hit_region, open_in_browser, start_global_audio, stop_global_audio])
        .run(tauri::generate_context!()).expect("error while running Agent Avatar");
}
