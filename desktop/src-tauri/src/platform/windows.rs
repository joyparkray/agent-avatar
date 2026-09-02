//! Windows 侧的平台胶水。接口定义见 `platform/mod.rs`。

use std::path::Path;
use std::process::Command;

/// 在资源管理器里打开一个目录。
///
/// `explorer.exe` 即使成功也常返回退出码 1，所以这里只 `spawn` 不 `wait` —— 判它的退出码
/// 会把正常情况误报成失败。
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    Command::new("explorer").arg(path).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

/// 用默认浏览器打开 URL。调用方负责先把 URL 限定到白名单内。
///
/// 不走 `cmd /C start`：那条要经 shell 解析，URL 里的 `&` 会被当成命令分隔符，
/// 是一条现成的注入面。`explorer.exe` 直接收参数、不过 shell。
pub fn open_in_default_browser(url: &str) -> Result<(), String> {
    Command::new("explorer").arg(url).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

/// Windows 上**没有** `lsof` 的等价物，本轮先降级：不做自动发现，
/// 只认 `AGENT_AVATAR_AUDIO_ENDPOINT` 环境变量（调用方在拿不到端口时会走那条路）。
///
/// 影响面限于 Hermes 的口型同步 —— 状态显示、动作、渲染都不经过这里。
/// 真要做自动发现，候选是解析 `netstat -ano`，属于后续增强，见 WINDOWS-PORT.md WP2。
pub fn listening_ports() -> Vec<u16> {
    vec![]
}

/// 全局音频采集（WASAPI loopback）。实现见 `windows_audio`。
pub fn start_global_audio() -> Result<(), String> { super::windows_audio::start() }
pub fn stop_global_audio() { super::windows_audio::stop() }
