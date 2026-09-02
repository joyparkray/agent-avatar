// Windows 上必须声明 GUI 子系统，否则每次启动都会连带弹出一个控制台窗口并常驻。
// 这条在纯 macOS 时期不需要，所以一直没有 —— Windows 版才暴露出来。
// 只对发布版生效：调试版留着控制台，`cargo run` 的 panic 才有地方打印。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() { agent_avatar_lib::run() }
