//! 测试专用的跨平台「重解析点」工具。
//!
//! 两处安全测试（`config::copy_tree` 不跟随链接、`static_server::resolve_within` 拒绝越界）
//! 原本直接调 `std::os::unix::fs::symlink`，在 Windows 上**整个 test 二进制编译不过**。
//!
//! 不能简单换成 `std::os::windows::fs::symlink_file`：Windows 上创建符号链接需要管理员权限
//! 或开启开发者模式，普通开发机上必然失败。那样会变成「CI（runner 是管理员）绿、开发者本机红」，
//! 比编不过更难查。
//!
//! 所以 Windows 侧改用**目录联接（junction）**：它不需要任何特权，而且是 Windows 上真实存在的
//! 同类攻击面 —— 把一个带 junction 的模型文件夹递给用户，效果与 Unix 的符号链接逃逸一样。
//! 被测代码对两者的判定是同一条：`FileType::is_symlink()` 对 junction 同样为真，
//! `canonicalize()` 也会把 junction 解开，所以覆盖的是同一个分支。

use std::io;
use std::path::Path;

/// 造一个指向 `target` 目录的重解析点。Unix 用符号链接，Windows 用目录联接。
///
/// Windows 上走 `mklink /J` 而不是 `std::os::windows::fs::symlink_dir`：后者同样要特权，
/// 前者不要。std 没有创建 junction 的 API，只能借 `cmd`。
pub fn link_dir(target: &Path, link: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        // `Path::join("a/b")` 会留下混合分隔符（`...\haru/leak_dir`）。Windows API 认，
        // 但 `cmd` 把 `/leak_dir` 当成开关，报的还是没头没脑的 "Invalid switch"。
        let fix = |p: &Path| p.to_string_lossy().replace('/', "\\");
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(fix(link))
            .arg(fix(target))
            .output()?;
        if out.status.success() {
            Ok(())
        } else {
            // 把 mklink 自己的话带出来：只报 exit code 1 时根本看不出是路径不存在、
            // 已存在，还是成环被拒
            Err(io::Error::other(format!(
                "mklink /J {} {} 失败（{}）：{}{}",
                link.display(),
                target.display(),
                out.status,
                String::from_utf8_lossy(&out.stdout).trim(),
                String::from_utf8_lossy(&out.stderr).trim(),
            )))
        }
    }
}
