//! 平台胶水：同一件事在 macOS 与 Windows 上**做法不同**的，全收在这里。
//!
//! 规矩是「实现分文件，接口统一」：调用方只看见 `platform::open_in_default_browser` 这样的
//! 函数名，看不出底下是 `open` 还是 `explorer`。好处有两个 ——
//!
//! 1. 共享逻辑（`config.rs`、`lib.rs`、`hermes.rs`）里不散落 `#[cfg]`，读起来还是一条直线；
//! 2. 两个平台一起升级时，需要对照着改的只有这一个目录，不用满仓库找平台分支。
//!
//! 目前收在这里的：打开浏览器、枚举监听端口、**全局音频采集**。
//! 最后一项两边差得最远 —— macOS 是 Core Audio process tap（Objective-C，能排除自身音频），
//! Windows 是 WASAPI loopback（纯 Rust）。但对外只吐 `global-audio-level` 与
//! `global-audio-error` 两个事件，形状完全一致，所以前端 `audio-source.ts` 一行都不用改。
//!
//! 反过来，**只是路径/字符串不同、逻辑完全一样**的东西不该进来（比如临时目录：
//! `env::temp_dir()` 本身就是跨平台的，那是修 bug，不是平台分支）。

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
mod windows_audio;
#[cfg(target_os = "windows")]
pub use windows::*;

// 明确不做 Linux 版（见 WINDOWS-PORT.md「四、后续 roadmap」）。不加这条的话，
// 在别的平台上编译会散出一堆「找不到函数」的错，指不到真正的原因。
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
compile_error!("Agent Avatar 只支持 macOS 与 Windows，见 WINDOWS-PORT.md");
