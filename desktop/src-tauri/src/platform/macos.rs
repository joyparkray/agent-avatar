//! macOS 侧的平台胶水。接口定义见 `platform/mod.rs`。

use std::process::Command;

/// 用默认浏览器打开 URL。调用方负责先把 URL 限定到白名单内。
pub fn open_in_default_browser(url: &str) -> Result<(), String> {
    Command::new("open").arg(url).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

/// 本机处于 LISTEN 的端口，用于自动发现 Hermes 音频端点。
///
/// `lsof` 的输出解析放在 `hermes::parse_listening_ports`：那段有一个容易踩的坑
/// （USER 列可能恰好就是 `hermes`，按行 contains 会全中），连同回归用例一起留在 hermes 里，
/// 不跟着搬家。这里只负责「怎么问操作系统要这份清单」这件平台相关的事。
pub fn listening_ports() -> Vec<u16> {
    let Ok(output) = Command::new("lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN"]).output() else {
        return vec![];
    };
    crate::hermes::parse_listening_ports(&String::from_utf8_lossy(&output.stdout))
}

// ---------------------------------------------------------------------------
// 全局音频采集 —— Core Audio process tap，原生实现在 native/AudioCapture.m
// ---------------------------------------------------------------------------
extern "C" {
    fn echo_global_audio_start(callback: extern "C" fn(f32));
    fn echo_global_audio_stop();
    fn echo_global_audio_last_error() -> *const std::os::raw::c_char;
}

/// 原生侧每算完一段就回调一次。负值表示出错 —— C 那边没有别的通道能把失败带出来。
extern "C" fn on_level(level: f32) {
    let Some(app) = crate::APP_HANDLE.get() else { return };
    if level < 0.0 {
        // 带出原生侧具体失败的那一步与 OSStatus，否则前端只知道「失败了」
        let reason = unsafe { std::ffi::CStr::from_ptr(echo_global_audio_last_error()) }
            .to_string_lossy().into_owned();
        let _ = tauri::Emitter::emit(app, "global-audio-error", reason);
        return;
    }
    let _ = tauri::Emitter::emit(app, "global-audio-level", level);
}

pub fn start_global_audio() -> Result<(), String> {
    unsafe { echo_global_audio_start(on_level) };
    Ok(())
}

pub fn stop_global_audio() {
    unsafe { echo_global_audio_stop() };
}
