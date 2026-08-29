//! 配置与用户数据目录。
//!
//! **为什么不存进 .app**：Apple 的 File System Programming Guide 原话 ——「You cannot write to
//! this directory. To prevent tampering, the bundle directory is signed at installation time.
//! Writing to this directory changes the signature and prevents your app from launching.」
//! M3 要做签名公证，往自己包里写东西等于自杀；`/Applications` 下普通用户也没有写权限，
//! 而且每次更新会整包覆盖。同一份文档指定的正确去处是 `Library/Application Support/<bundle-id>`,
//! 也就是 Tauri `app_data_dir()` 返回的路径。
use crate::user_error;
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, process::Command};
use tauri::{Manager, Runtime};

/// 配置文件的体积上限。正常只有几百字节；手改坏或塞了别的东西时直接当默认处理，不去解析。
const MAX_CONFIG_BYTES: u64 = 64 * 1024;

/// 读不到 / 读坏时给空对象，各项默认值由前端决定 —— 那里本来就有每个设置的合法范围。
pub fn defaults() -> Value {
    json!({})
}

/// 目录名必须是单层、无分隔符、无隐藏前缀 —— 它会被拼进路径与 URL。
pub fn is_safe_dir_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 已安装模型可能位于官网下载包的嵌套目录（如 `hiyori_pro/runtime`）。
/// 每一段仍沿用单层目录白名单，拒绝空段、绝对路径与 `..`。
fn is_safe_model_path(path: &str) -> bool {
    !path.is_empty() && !path.starts_with('/') && path.split('/').all(is_safe_dir_name)
}

/// 只做**文件级**把关：必须是 JSON object，且会被拼进路径的字段不能越界。
///
/// 字段级的合法范围（fps 只能 30/60、statusPosition 的白名单、缩放 50–300…）**留在前端** ——
/// 那里每个设置本来就有自己的钳制逻辑，两处各写一份必然会漂，而漂了之后表现是
/// 「设置里明明改了却不生效」，最难查。
///
/// 手改坏的配置**不该让应用起不来**：整份读不动就当空的，前端各项退回默认值。
pub fn sanitize(value: &Value) -> Value {
    let Some(map) = value.as_object() else { return defaults() };
    let mut out = map.clone();
    // model / modelSource 会参与拼路径与 URL。虽然 static_server 侧还有一道穿越防护，
    // 但让非法值落进配置文件本身就不对 —— 它会一直留在那儿。
    if !out.get("model").and_then(Value::as_str).is_some_and(is_safe_model_path) {
        out.remove("model");
    }
    Value::Object(out)
}

/// 用户数据根目录，按需创建 —— Tauri 只解析路径，不会替我们建目录。
/// 改名前的 bundle identifier。数据目录由 identifier 决定，所以 2026-08-28 从
/// `Echo Skin` 改名成 `Agent Avatar` 时，用户已有的 `config.json` 与装好的模型
/// 会留在旧目录里变成孤儿 —— 表现是「升级后设置全没了、装的模型也不见了」。
const LEGACY_IDENTIFIER: &str = "com.hermes.echo.skin";

/// 一次性搬迁：把旧目录里**新目录还没有的**条目搬过来。
///
/// 判据是**逐个条目是否存在**，不是「新目录是否存在」—— 后者一试就错：
/// 新目录会被更早的调用方（或 Tauri 自己）抢先建成空目录，
/// 于是迁移永远不触发，用户看到的是「升级后设置全没了、装的模型也不见了」
/// （2026-08-28 实测撞到）。
///
/// 已经存在的条目一律不覆盖，所以重复执行安全，也不会用旧数据盖掉新数据。
/// 搬迁失败不算错误：大不了退回默认设置，不该让应用起不来。
fn migrate_legacy_data_dir(new_dir: &Path) {
    let Some(legacy) = new_dir.parent().map(|parent| parent.join(LEGACY_IDENTIFIER)) else { return };
    if !legacy.is_dir() { return; }
    let Ok(entries) = fs::read_dir(&legacy) else { return };
    let _ = fs::create_dir_all(new_dir);
    for entry in entries.flatten() {
        let target = new_dir.join(entry.file_name());
        // 空的 models/ 目录不该挡住旧的那份 —— 它是被抢先建出来的，不是用户数据。
        let vacant = match fs::read_dir(&target) {
            Ok(mut existing) => existing.next().is_none(),   // 目录存在但为空
            Err(_) => !target.exists(),                      // 不是目录：只在完全不存在时搬
        };
        if vacant { let _ = fs::rename(entry.path(), &target); }
    }
}

pub fn data_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    migrate_legacy_data_dir(&dir);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

/// 用户自己装的模型放这里。随包模型仍走内嵌资源，两者在菜单里合并。
pub fn models_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("models");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn config_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("config.json"))
}

fn read_file(path: &Path) -> Option<Value> {
    if fs::metadata(path).ok()?.len() > MAX_CONFIG_BYTES { return None; }
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

#[tauri::command(async)]
pub fn read_config(app: tauri::AppHandle) -> Value {
    let Ok(path) = config_path(&app) else { return defaults() };
    read_file(&path).as_ref().map_or_else(defaults, sanitize)
}

#[tauri::command(async)]
pub fn write_config(app: tauri::AppHandle, config: Value) -> Result<(), String> {
    let path = config_path(&app)?;
    let temporary = path.with_extension("json.writing");
    // 先写临时文件再 rename：中途崩溃不会留下半个 JSON 把下次启动坑掉。
    fs::write(&temporary, serde_json::to_vec_pretty(&sanitize(&config)).map_err(|e| e.to_string())?)
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}

/// 在访达里打开用户模型目录。**不接受参数** —— 路径由应用决定，避免变成任意路径打开器。
#[tauri::command(async)]
pub fn open_models_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = models_dir(&app)?;
    Command::new("open").arg(&dir).spawn().map_err(|error| error.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 安装：把用户拖进来的模型目录收进应用自己的模型目录
// ---------------------------------------------------------------------------
/// 单个模型的体积/数量上限。拖错文件夹（比如整个「下载」）时立刻停手，而不是闷头拷贝几个 G。
const MAX_MODEL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MODEL_FILES: usize = 2000;

/// 目录里是不是一个 Cubism 4 模型：认 `*.model3.json`。
fn find_model3(dir: &Path) -> Option<String> {
    fs::read_dir(dir).ok()?.flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .find(|name| name.ends_with(".model3.json"))
}

/// 模型目录最多往下找几层。
///
/// Live2D 官网下载的包解压出来是**三层**，实测：
/// `hiyori_zh-Hans/hiyori_pro/runtime/hiyori_pro_t11.model3.json`
/// —— 下载包名 / 模型变体 / `runtime`。最后那层是 Cubism 的标准布局（官方示例模型都放
/// `<模型>/runtime/` 下）。只认顶层的话官方包一个都装不上，而用户没有理由去理解这层结构。
const MODEL_SCAN_DEPTH: usize = 3;

/// 菜单里显示的名字。
///
/// 直接用相对路径会显示成 `hiyori_zh-Hans/hiyori_pro/runtime`，又长又把 `runtime` 这个
/// 纯属布局的目录名摆出来。去掉 `runtime`，其余层级用「 / 」串起来。
///
/// **保留父目录不是啰嗦**：一个文件夹里常装着好几个角色（`tororo_hijiki_ja` 里有
/// tororo 和 hijiki），只显示最后一段的话，用户看到「文件夹里 2 个、菜单里 3 个」
/// 会以为菜单坏了 —— 实机被当成 bug 报过两次。带上父目录，数目自己就对上了。
fn model_label(relative: &str) -> String {
    let parts: Vec<&str> = relative.split('/').filter(|segment| *segment != "runtime").collect();
    if parts.is_empty() { return relative.to_owned(); }
    parts.join(" / ")
}

/// 在 `root` 下找出所有模型目录，返回（相对 root 的路径, model3 文件名）。
///
/// 找到一个就不再往它下面钻：模型目录内部还有 `motions/` 之类的子目录，没必要遍历。
fn find_model_dirs(root: &Path, relative: &str, depth: usize, found: &mut Vec<(String, String)>) {
    if let Some(model3) = find_model3(root) {
        found.push((relative.to_owned(), model3));
        return;
    }
    if depth == 0 { return; }
    let Ok(entries) = fs::read_dir(root) else { return };
    let mut children: Vec<_> = entries.flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| is_safe_dir_name(name))
        .collect();
    children.sort();
    for name in children {
        let next = if relative.is_empty() { name.clone() } else { format!("{relative}/{name}") };
        find_model_dirs(&root.join(&name), &next, depth - 1, found);
    }
}

/// 递归复制，**跳过符号链接** —— 跟随的话可以把目录外的任意文件拷进来。
fn copy_tree(from: &Path, to: &Path, budget: &mut (u64, usize)) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(from).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_symlink() { continue; }
        let (source, target) = (entry.path(), to.join(entry.file_name()));
        if kind.is_dir() {
            copy_tree(&source, &target, budget)?;
        } else {
            budget.0 += entry.metadata().map_err(|error| error.to_string())?.len();
            budget.1 += 1;
            if budget.0 > MAX_MODEL_BYTES || budget.1 > MAX_MODEL_FILES {
                return Err(user_error::TOO_LARGE.to_owned());
            }
            fs::copy(&source, &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// 安装拖进窗口的模型目录。返回安装后的目录名与它的 model3 文件名。
///
/// 准入门槛就是**官方约定**：目录里（含下两层子目录）有 `*.model3.json` 即可。口型参数（`Groups[LipSync]`）、
/// 眨眼参数（`Groups[EyeBlink]`）、动作组与表情清单都由 model3.json 自带，SDK/库直接读，
/// 我们不需要用户再手写一份。
///
/// `avatar.json` 是**可选**的精细适配，只提供官方给不了的那一样东西 ——
/// 「8 个语义态各播哪个动作/表情」（researching 之类是我们的产品概念，模型作者不会知道）。
/// 没有它时全部回落到 `Idle` 组（见前端 STATE_FALLBACK），模型照样能动、能眨眼、能对口型。
#[tauri::command(async)]
pub fn install_model(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    let source = PathBuf::from(&path);
    if !source.is_dir() {
        let name = source.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
        if ARCHIVE_EXTS.iter().any(|ext| name.ends_with(ext)) {
            return Err(user_error::ARCHIVE.to_owned());
        }
        return Err(user_error::NOT_A_FOLDER.to_owned());
    }
    let name = source.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_owned();
    if !is_safe_dir_name(&name) {
        return Err(format!("{}|{name}", user_error::BAD_NAME));
    }
    // 顶层没有就往下找两层：官方包解压后模型常在子目录里（见 MODEL_SCAN_DEPTH）。
    let mut found = vec![];
    find_model_dirs(&source, "", MODEL_SCAN_DEPTH, &mut found);
    let Some((_, model3)) = found.first().cloned() else {
        return Err(user_error::NO_MODEL3.to_owned());
    };
    let target = models_dir(&app)?.join(&name);
    if target.exists() {
        return Err(format!("{}|{name}", user_error::ALREADY_INSTALLED));
    }
    // 先拷到临时名再改名：中途失败不会留下半个模型目录，让菜单里多出一个打不开的条目。
    let staging = target.with_extension("installing");
    if staging.exists() { let _ = fs::remove_dir_all(&staging); }
    let mut budget = (0u64, 0usize);
    if let Err(error) = copy_tree(&source, &staging, &mut budget) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    fs::rename(&staging, &target).map_err(|error| error.to_string())?;
    Ok(json!({ "dir": name, "model3": model3 }))
}

/// 用户装了哪些模型。带上 model3 文件名 —— 前端没法列目录，而没有 `avatar.json` 的模型
/// 正需要从这里知道该加载哪个 model3.json。
#[tauri::command(async)]
pub fn list_installed_models(app: tauri::AppHandle) -> Vec<Value> {
    let Ok(root) = models_dir(&app) else { return vec![] };
    let mut found = vec![];
    find_model_dirs(&root, "", MODEL_SCAN_DEPTH, &mut found);
    found.into_iter()
        .filter(|(relative, _)| !relative.is_empty())  // root 自己不是模型
        .map(|(relative, model3)| json!({
            "dir": relative,
            "label": model_label(&relative),
            "model3": model3,
            "adapted": root.join(&relative).join("avatar.json").is_file(),
        }))
        .collect()
}

fn deletion_target(root: &Path, dir: &str, found: &[(String, String)]) -> Option<PathBuf> {
    found.iter().any(|(relative, _)| relative == dir)
        .then(|| dir.split('/').fold(root.to_path_buf(), |path, part| path.join(part)))
}

/// 删完模型目录后，把**已经不含任何模型**的上层目录一并清掉。
///
/// 官方下载包解压出来是 `ren_zh-Hans/runtime/`，被认成模型的是 `runtime` 那一层，
/// 而外层还躺着 `.cmo3`/`.can3`/`.psd`/ReadMe。只删 `runtime` 的话，用户在访达里
/// 看到「删除了却还剩一堆文件」，而那些残留他在界面上再也删不掉（没有 model3，
/// 列表里根本不出现）—— 实机撞到。
///
/// **上层还有别的模型时不动它**：一个文件夹里常装着好几个角色
/// （`tororo_hijiki_ja` 里有 tororo 和 hijiki），删一个不该把另一个带走。
fn prune_modelless_ancestors(root: &Path, deleted: &Path) {
    let mut current = deleted.parent();
    while let Some(dir) = current {
        // 只在模型根**之内**往上走，绝不删到根自己
        if dir == root || !dir.starts_with(root) { return; }
        let mut remaining = vec![];
        find_model_dirs(dir, "", MODEL_SCAN_DEPTH, &mut remaining);
        if !remaining.is_empty() { return; }
        if fs::remove_dir_all(dir).is_err() { return; }
        current = dir.parent();
    }
}

/// 删除一个扫描得到的用户模型。先用扫描结果确认目标，避免前端参数变成任意目录删除器。
#[tauri::command(async)]
pub fn delete_model(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    let root = models_dir(&app)?;
    let mut found = vec![];
    find_model_dirs(&root, "", MODEL_SCAN_DEPTH, &mut found);
    let target = deletion_target(&root, &dir, &found).ok_or(user_error::UNKNOWN_MODEL)?;
    fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    prune_modelless_ancestors(&root, &target);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{copy_tree, defaults, deletion_target, find_model3, is_safe_dir_name, is_safe_model_path, sanitize};
    use serde_json::json;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    /// 每个用例一个独立目录：本进程的测试并发跑，共用目录会互相踩。
    fn scratch(tag: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("agent-avatar-{tag}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn deletion_only_targets_a_scanned_model() {
        let root = std::path::Path::new("/models");
        let found = vec![("pack/runtime".to_owned(), "avatar.model3.json".to_owned())];
        assert_eq!(deletion_target(root, "pack/runtime", &found), Some(root.join("pack/runtime")));
        assert_eq!(deletion_target(root, "../outside", &found), None);
        assert_eq!(deletion_target(root, "pack", &found), None);
    }

    #[test]
    fn accepts_nested_model_paths_but_rejects_traversal() {
        assert!(is_safe_model_path("hiyori_pro/runtime"));
        assert!(is_safe_model_path("pack/model/runtime"));
        assert!(!is_safe_model_path("../outside"));
        assert!(!is_safe_model_path("pack//runtime"));
        assert!(!is_safe_model_path("/absolute"));
        assert_eq!(sanitize(&json!({ "model": "hiyori_pro/runtime" }))["model"], "hiyori_pro/runtime");
        assert!(sanitize(&json!({ "model": "../outside" })).get("model").is_none());
    }

    #[test]
    fn rejects_names_that_could_escape_the_models_directory() {
        for name in ["haru", "my-model", "model_2"] { assert!(is_safe_dir_name(name), "{name}"); }
        for name in ["", "..", "../etc", "a/b", "a\\b", ".hidden", &"x".repeat(65)] {
            assert!(!is_safe_dir_name(name), "{name}");
        }
    }

    #[test]
    fn passes_settings_through_and_only_guards_path_fields() {
        // 字段级校验在前端；这里只保证「能拼进路径的东西」不越界
        let value = json!({ "model": "hiyori", "statusPosition": "top-left", "pools": { "haru": ["a"] } });
        assert_eq!(sanitize(&value), value);

        let escaping = json!({ "model": "../../etc", "scalePercent": 120 });
        assert_eq!(sanitize(&escaping), json!({ "scalePercent": 120 }), "非法 model 必须被摘掉");
    }

    #[test]
    fn a_broken_config_falls_back_to_empty_instead_of_failing() {
        // 手改坏的配置不该让应用起不来 —— 整份当空的，前端各项退回默认值
        for broken in [json!("not an object"), json!(null), json!([1, 2, 3])] {
            assert_eq!(sanitize(&broken), defaults(), "{broken}");
        }
    }

    #[test]
    fn recognizes_a_cubism_model_directory() {
        let dir = scratch("model3");
        assert_eq!(find_model3(&dir), None);
        fs::write(dir.join("readme.txt"), b"x").unwrap();
        assert_eq!(find_model3(&dir), None);  // 有文件但不是模型
        fs::write(dir.join("Haru.model3.json"), b"{}").unwrap();
        assert_eq!(find_model3(&dir).as_deref(), Some("Haru.model3.json"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn finds_models_nested_inside_an_official_download_folder() {
        // 回归：Live2D 官网包解压后是「外层目录 + 变体子目录」（实测 hiyori_zh-Hans/hiyori_pro），
        // 只认顶层的话用户把整个包丢进模型文件夹，菜单里一个都不出现。
        let root = scratch("nested");
        fs::create_dir_all(root.join("hiyori_zh-Hans/hiyori_pro/runtime")).unwrap();
        fs::create_dir_all(root.join("hiyori_zh-Hans/hiyori_free/runtime")).unwrap();
        fs::create_dir_all(root.join("plain")).unwrap();
        fs::write(root.join("hiyori_zh-Hans/hiyori_pro/runtime/a.model3.json"), b"{}").unwrap();
        fs::write(root.join("hiyori_zh-Hans/hiyori_free/runtime/b.model3.json"), b"{}").unwrap();
        fs::write(root.join("plain/c.model3.json"), b"{}").unwrap();

        let mut found = vec![];
        super::find_model_dirs(&root, "", super::MODEL_SCAN_DEPTH, &mut found);
        let mut dirs: Vec<_> = found.iter().map(|(dir, _)| dir.as_str()).collect();
        dirs.sort();
        assert_eq!(dirs, ["hiyori_zh-Hans/hiyori_free/runtime", "hiyori_zh-Hans/hiyori_pro/runtime", "plain"]);
        // 名字不该显示成 .../runtime，但父目录要留着 —— 一个文件夹里可能有好几个角色
        assert_eq!(super::model_label("hiyori_zh-Hans/hiyori_pro/runtime"), "hiyori_zh-Hans / hiyori_pro");
        assert_eq!(super::model_label("plain"), "plain");
        assert_eq!(super::model_label("haru_ja/runtime"), "haru_ja");
        // 同一个文件夹里的两个角色必须能分辨出来（实机：tororo_hijiki_ja 装了两个）
        assert_ne!(super::model_label("tororo_hijiki_ja/tororo/runtime"),
                   super::model_label("tororo_hijiki_ja/hijiki/runtime"));
        assert_eq!(super::model_label("tororo_hijiki_ja/tororo/runtime"), "tororo_hijiki_ja / tororo");
        // 只有 runtime 一层时不能落成空名字
        assert_eq!(super::model_label("runtime"), "runtime");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn stops_descending_once_a_model_is_found() {
        // 模型目录内部还有 motions/ 之类的子目录，找到就别再往下钻。
        let root = scratch("stop");
        fs::create_dir_all(root.join("model/motions")).unwrap();
        fs::write(root.join("model/x.model3.json"), b"{}").unwrap();
        fs::write(root.join("model/motions/y.model3.json"), b"{}").unwrap();
        let mut found = vec![];
        super::find_model_dirs(&root, "", super::MODEL_SCAN_DEPTH, &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "model");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn deleting_a_nested_model_takes_the_download_folder_leftovers_with_it() {
        // 官方包是 `<包名>/runtime/`，模型是 runtime 那层，外层还有 .cmo3/.psd/ReadMe。
        // 只删 runtime 的话用户看到「删了却还剩一堆文件」，而且再也删不掉（实机撞到）。
        let root = scratch("prune");
        fs::create_dir_all(root.join("ren_zh-Hans/runtime")).unwrap();
        fs::write(root.join("ren_zh-Hans/runtime/ren.model3.json"), b"{}").unwrap();
        fs::write(root.join("ren_zh-Hans/ren_t01.cmo3"), b"source").unwrap();
        fs::write(root.join("ren_zh-Hans/ReadMe.txt"), b"readme").unwrap();
        let target = root.join("ren_zh-Hans/runtime");
        fs::remove_dir_all(&target).unwrap();
        super::prune_modelless_ancestors(&root, &target);
        assert!(!root.join("ren_zh-Hans").exists(), "外层残留必须一起清掉");
        assert!(root.is_dir(), "模型根目录本身绝不能被删");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn deleting_one_character_keeps_its_siblings() {
        // 一个下载包里常有好几个角色（tororo_hijiki_ja 里有 tororo 和 hijiki）
        let root = scratch("prune-sibling");
        for name in ["tororo", "hijiki"] {
            fs::create_dir_all(root.join(format!("pack/{name}/runtime"))).unwrap();
            fs::write(root.join(format!("pack/{name}/runtime/{name}.model3.json")), b"{}").unwrap();
        }
        let target = root.join("pack/tororo/runtime");
        fs::remove_dir_all(&target).unwrap();
        super::prune_modelless_ancestors(&root, &target);
        assert!(!root.join("pack/tororo").exists(), "被删角色的空壳目录该清掉");
        assert!(root.join("pack/hijiki/runtime/hijiki.model3.json").is_file(), "另一个角色必须原样保留");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn copy_tree_skips_symlinks_and_keeps_the_tree() {
        // 跟随符号链接等于允许把目录外的任意文件拷进用户模型目录。
        let root = scratch("copy");
        let (from, to) = (root.join("from"), root.join("to"));
        let outside = root.join("secret.txt");
        fs::create_dir_all(from.join("nested")).unwrap();
        fs::write(&outside, b"do not copy me").unwrap();
        fs::write(from.join("Haru.model3.json"), b"{}").unwrap();
        fs::write(from.join("nested/texture.png"), b"pixels").unwrap();
        std::os::unix::fs::symlink(&outside, from.join("leak.txt")).unwrap();

        let mut budget = (0u64, 0usize);
        copy_tree(&from, &to, &mut budget).unwrap();
        assert!(to.join("Haru.model3.json").is_file());
        assert!(to.join("nested/texture.png").is_file());
        assert!(!to.join("leak.txt").exists(), "符号链接不该被跟随复制");
        assert_eq!(budget.1, 2);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn copy_tree_stops_when_the_folder_is_clearly_not_a_model() {
        // 拖错文件夹（比如整个「下载」）时立刻停手，不闷头拷几个 G。
        let root = scratch("budget");
        let (from, to) = (root.join("from"), root.join("to"));
        fs::create_dir_all(&from).unwrap();
        for index in 0..3 { fs::write(from.join(format!("f{index}")), b"x").unwrap(); }
        let mut budget = (0u64, super::MAX_MODEL_FILES);  // 预算已用尽
        assert!(copy_tree(&from, &to, &mut budget).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}


/// 认得出的压缩包后缀。我们**不解压** —— macOS 双击即可解压，而自己解压要么引依赖、
/// 要么调外部命令还得防 zip slip，不划算。但必须让用户知道为什么它没变成模型。
const ARCHIVE_EXTS: [&str; 6] = [".zip", ".7z", ".rar", ".tar", ".gz", ".tgz"];

/// 模型目录里**没能变成模型**的东西，连同原因。
///
/// 用户把官网下载的压缩包直接丢进模型文件夹时，原来是完全静默的：菜单里不出现，
/// 也没有任何解释 —— 除了来问，没有别的办法知道发生了什么。
#[tauri::command(async)]
pub fn list_model_issues(app: tauri::AppHandle) -> Vec<Value> {
    let Ok(root) = models_dir(&app) else { return vec![] };
    let mut found = vec![];
    find_model_dirs(&root, "", MODEL_SCAN_DEPTH, &mut found);
    // 已识别模型所在的顶层目录，不必再报
    let recognized: Vec<String> = found.iter()
        .filter_map(|(relative, _)| relative.split('/').next().map(str::to_owned))
        .collect();
    let Ok(entries) = fs::read_dir(&root) else { return vec![] };
    entries.flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_owned();
            if name.starts_with('.') { return None; }  // .DS_Store 之类不打扰
            let kind = entry.file_type().ok()?;
            if kind.is_file() {
                let lower = name.to_lowercase();
                return ARCHIVE_EXTS.iter().any(|ext| lower.ends_with(ext))
                    .then(|| json!({ "name": name, "reason": "archive" }));
            }
            if !kind.is_dir() || recognized.contains(&name) { return None; }
            Some(json!({ "name": name, "reason": if is_safe_dir_name(&name) { "no-model3" } else { "bad-name" } }))
        })
        .collect()
}
