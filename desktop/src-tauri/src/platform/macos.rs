//! macOS 侧的平台胶水。接口定义见 `platform/mod.rs`。

use std::path::Path;
use std::process::Command;

/// 在访达里打开一个目录。
pub fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    Command::new("open").arg(path).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

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
