//! 模型清洗：把用户拖进来的模型规整成应用能直接用的形状。
//!
//! 为什么需要这一步 —— 网上下载的模型（尤其是 VTuber 向的）有两个共性毛病：
//!
//! 1. **文件夹名带空格或中文**（`yoyo - b`、`yoyodlc1 - f`）。名字会被拼进 URL，而内嵌服务器
//!    的 `asset_path` 直接拒绝含 `%` 的路径（防路径穿越），所以带空格的名字根本取不到文件。
//!    原来的做法是**整个拒绝安装**，用户只看到一句「名字不能用」，得自己去改名。
//! 2. **表情文件在、但没登记进 `model3.json`**。VTube Studio 那一系用自己的 `.vtube.json`
//!    记热键，不写 Cubism 的清单；而 Cubism 库只认 `model3.json`，于是 18 个表情一个都用不了。
//!
//! 清洗**只在我们自己的目录里做**（安装是先拷进暂存目录再提交），用户拖进来的源文件夹全程只读。
//!
//! 两条硬规矩：
//! - **只增不改**：绝不动作者已经声明的东西，也绝不碰 `.moc3` 与贴图。
//! - **可逆**：动过的 JSON 留一份 `.orig`；重洗永远从 `.orig` 重建，而不是在上次结果上叠加。
//!   （否则清洗规则一改，反复安装同一个模型会叠出越来越奇怪的清单。）

use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// 清洗规则的版本。规则变了就加一，扫描时据此判断已装的模型要不要重洗。
pub const CLEANER_VERSION: u32 = 2;

/// 清洗留下的标记文件。点开头 —— `list_model_issues` 会跳过点开头的条目，不会把它当成坏模型报出来。
pub const MARKER: &str = ".agent-avatar-clean.json";

#[derive(Debug, Default, PartialEq)]
pub struct CleanReport {
    /// 这次补登记了几个表情（已经声明过的不计）。
    pub registered_expressions: usize,
    /// 这次补登记了几个动作（作者已经分过组时恒为 0）。
    pub registered_motions: usize,
}

/// 把任意文件夹名规整成 `is_safe_dir_name` 认可的形状。
///
/// 规则：ASCII 字母数字与 `-` `_` 原样保留，其余一律变 `-`，再把连续的 `-` 压成一个、
/// 去掉首尾的 `-`。全部字符都不合法时（比如纯中文名）回落到 `model`，由调用方去处理重名。
///
/// **不做音译**：中文名转拼音要引词库，而这个名字只是内部目录名 —— 界面上显示的是
/// `model_label()`，用户并不直接看它。
pub fn normalize_dir_name(raw: &str) -> String {
    let mapped: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let mut out = String::with_capacity(mapped.len());
    for part in mapped.split('-').filter(|piece| !piece.is_empty()) {
        if !out.is_empty() { out.push('-'); }
        out.push_str(part);
    }
    let trimmed = out.trim_matches('_');
    let cleaned = if trimmed.is_empty() { "model" } else { trimmed };
    // `is_safe_dir_name` 的上限是 64；按字符截断（这里全是 ASCII，不会切坏多字节）
    cleaned.chars().take(64).collect::<String>().trim_end_matches(['-', '_']).to_owned()
}

/// 目录里的 `*.model3.json`（只看这一层）。
fn model3_in(dir: &Path) -> Option<std::path::PathBuf> {
    fs::read_dir(dir).ok()?.flatten()
        .map(|entry| entry.path())
        .find(|path| path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".model3.json")))
}

/// vtube.json 里被作者绑成「触发动画」的那些动作文件（只取文件名）。
///
/// 为什么要看它：这类模型的 `motions/` 里混着两种东西 —— 作者绑了热键的**真动作**
///（CandyBoy 是 q/w/e/a/s/d/z/x/c 九个），以及 `mousex` / `mousey` 这种**鼠标跟随的辅助曲线**。
/// 后者当动作播出来就是乱抖。作者自己的热键表是唯一能可靠区分两者的依据。
/// 没有 vtube.json 时回落到「目录里全部」，由用户在设置里关掉不想要的。
fn author_declared_animations(dir: &Path) -> Option<Vec<String>> {
    let vtube = fs::read_dir(dir).ok()?.flatten().map(|entry| entry.path())
        .find(|path| path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".vtube.json")))?;
    let value: Value = serde_json::from_str(&fs::read_to_string(vtube).ok()?).ok()?;
    let names: Vec<String> = value.get("Hotkeys")?.as_array()?.iter()
        .filter(|hotkey| hotkey.get("Action").and_then(Value::as_str) == Some("TriggerAnimation"))
        .filter_map(|hotkey| hotkey.get("File")?.as_str().map(str::to_owned))
        .filter(|file| file.ends_with(".motion3.json"))
        .collect();
    (!names.is_empty()).then_some(names)
}

/// 目录里的动作文件，返回**相对 model3.json** 的路径。只看本层与 `motions/` 一层 ——
/// Cubism 的惯例就是放在 `motions/` 下，再深就不是动作目录了。
fn motion_files(dir: &Path) -> Vec<String> {
    let mut out = vec![];
    for sub in ["", "motions"] {
        let target = if sub.is_empty() { dir.to_owned() } else { dir.join(sub) };
        let Ok(entries) = fs::read_dir(&target) else { continue };
        for name in entries.flatten().filter_map(|e| e.file_name().to_str().map(str::to_owned)) {
            if !name.ends_with(".motion3.json") { continue; }
            out.push(if sub.is_empty() { name } else { format!("{sub}/{name}") });
        }
    }
    out.sort();
    out
}

/// 把目录里没被 `model3.json` 声明的表情与动作补登记进去。返回（表情数, 动作数）。
///
/// 表情与动作**必须在同一次读写里做完**：两者都从 `.orig` 重建，分两次写的话
/// 后一次会把前一次的成果冲掉。
fn register_assets(dir: &Path) -> Result<(usize, usize), String> {
    let Some(model3) = model3_in(dir) else { return Ok((0, 0)) };
    let backup = model3.with_extension("json.orig");

    // 永远从原始文件重建：重洗时不叠加上一次的结果
    let source = if backup.is_file() { &backup } else { &model3 };
    let text = fs::read_to_string(source).map_err(|error| error.to_string())?;
    let mut value: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;

    let mut expression_files: Vec<String> = fs::read_dir(dir).map_err(|error| error.to_string())?
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| name.ends_with(".exp3.json"))
        .collect();
    expression_files.sort();

    let refs = value.get_mut("FileReferences")
        .and_then(Value::as_object_mut)
        .ok_or("model3.json 缺少 FileReferences")?;

    // ---- 表情 ----
    let declared: Vec<String> = refs.get("Expressions").and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|item| item.get("File")?.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    let added: Vec<Value> = expression_files.iter()
        .filter(|file| !declared.contains(file))
        .map(|file| json!({ "Name": file.trim_end_matches(".exp3.json"), "File": file }))
        .collect();
    let expressions = added.len();
    if expressions > 0 {
        let mut list = refs.get("Expressions").and_then(Value::as_array).cloned().unwrap_or_default();
        list.extend(added);
        refs.insert("Expressions".to_owned(), Value::Array(list));
    }

    // ---- 动作 ----
    // 作者**已经分好组**就完全不碰：分组是作者意图（哪几个算 Idle、哪几个算 TapBody），
    // 我们没有任何依据去改它，也不该往别人的组里塞东西。只有一条动作都没声明时才补。
    let mut motions = 0;
    let has_declared_motions = refs.get("Motions").and_then(Value::as_object).is_some_and(|map| !map.is_empty());
    if !has_declared_motions {
        let found = motion_files(dir);
        let chosen: Vec<String> = match author_declared_animations(dir) {
            // 热键表里记的是文件名，实际文件通常在 motions/ 下 —— 按 basename 对上
            Some(names) => found.into_iter()
                .filter(|path| names.iter().any(|name| path.rsplit('/').next() == Some(name.as_str())))
                .collect(),
            None => found,
        };
        motions = chosen.len();
        if motions > 0 {
            let entries: Vec<Value> = chosen.iter().map(|file| json!({ "File": file })).collect();
            // 统一放进 `Idle` 组：synthesizeManifest 优先找这个名字，八个语义态就能直接用上；
            // 想让不同状态播不同动作，在 设置 → Agent 里逐个改（那里按文件名列出每一条）。
            refs.insert("Motions".to_owned(), json!({ "Idle": entries }));
        }
    }

    if expressions == 0 && motions == 0 { return Ok((0, 0)); }

    // 先备份再写。备份只在第一次建 —— 它记的是「作者原始的样子」。
    if !backup.is_file() {
        fs::copy(&model3, &backup).map_err(|error| error.to_string())?;
    }
    fs::write(&model3, serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    Ok((expressions, motions))
}

/// 已经按当前规则清洗过了吗。
pub fn is_clean(dir: &Path) -> bool {
    fs::read_to_string(dir.join(MARKER)).ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("cleanerVersion")?.as_u64())
        .is_some_and(|version| version >= CLEANER_VERSION as u64)
}

/// 清洗一个**模型目录**（它自己就含 `model3.json`）。
pub fn clean_model(dir: &Path) -> Result<CleanReport, String> {
    let (registered_expressions, registered_motions) = register_assets(dir)?;
    let marker = json!({ "cleanerVersion": CLEANER_VERSION,
        "registeredExpressions": registered_expressions, "registeredMotions": registered_motions });
    fs::write(dir.join(MARKER), serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?)
        .map_err(|error| error.to_string())?;
    Ok(CleanReport { registered_expressions, registered_motions })
}

/// 把**通往模型目录的路径上**那些名字不合规的目录改名。
///
/// 只动模型目录**以上**的层级：一旦某层自己含 `model3.json`，就到此为止，绝不进去改 ——
/// 里面的 `yoyo.8192/` 之类是被 `model3.json` 按名字引用的贴图目录，改了就全断了。
/// 而路径上的目录没有任何人按名字引用（模型内部的相对路径都以 model3.json 自己为基准），
/// 所以改名是安全的。
///
/// 为什么必须做：官方下载包是嵌套的（`包名/模型名/runtime/x.model3.json`），
/// 而扫描器 `find_model_dirs` 会跳过名字不合规的中间层 —— 中间层带个空格，
/// 整个模型就装进去了却**永远不出现在菜单里**，且没有任何提示。
fn normalize_tree_dirs(dir: &Path, depth: usize) -> Result<(), String> {
    if depth == 0 || model3_in(dir).is_some() { return Ok(()); }
    let children: Vec<_> = fs::read_dir(dir).map_err(|e| e.to_string())?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect();
    for child in children {
        let Some(name) = child.file_name().and_then(|n| n.to_str()) else { continue };
        let normalized = normalize_dir_name(name);
        let target = if normalized == name {
            child.clone()
        } else {
            // 改名后撞名就让它保持原样：宁可这一个找不到，也不要把两个模型合成一个
            let candidate = dir.join(&normalized);
            if candidate.exists() { child.clone() } else { fs::rename(&child, &candidate).map_err(|e| e.to_string())?; candidate }
        };
        normalize_tree_dirs(&target, depth - 1)?;
    }
    Ok(())
}

/// 找出 `root` 之下所有含 `model3.json` 的目录（含 root 自己）。
/// 与 `config::find_model_dirs` 的区别：**不按名字过滤** —— 这里跑在改名之后，
/// 而且我们要找的正是那些名字可能还没规整好的目录。
fn model_dirs(root: &Path, depth: usize, found: &mut Vec<std::path::PathBuf>) {
    if model3_in(root).is_some() { found.push(root.to_owned()); return; }
    if depth == 0 { return; }
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) { model_dirs(&entry.path(), depth - 1, found); }
    }
}

/// 清洗一整棵刚拷进来的树：先把路径上的目录名规整好，再逐个清洗里面的模型。
///
/// 一个包里可能有**多个**角色（`tororo_hijiki_ja` 里就有两个），所以是「逐个」而不是「第一个」。
pub fn clean_tree(root: &Path, depth: usize) -> Result<CleanReport, String> {
    normalize_tree_dirs(root, depth)?;
    let mut found = vec![];
    model_dirs(root, depth, &mut found);
    let mut report = CleanReport::default();
    for dir in found {
        let one = clean_model(&dir)?;
        report.registered_expressions += one.registered_expressions;
        report.registered_motions += one.registered_motions;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("agent-avatar-clean-{tag}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn normalizes_the_names_real_downloads_actually_use() {
        // 实测遇到的三个：空格分隔、连字符两边带空格
        assert_eq!(normalize_dir_name("yoyo - b"), "yoyo-b");
        assert_eq!(normalize_dir_name("yoyodlc1 - f"), "yoyodlc1-f");
        assert_eq!(normalize_dir_name("Haru"), "Haru");
        // 已经合规的原样不动 —— 否则重装同一个模型会换个目录名
        assert_eq!(normalize_dir_name("my_model-2"), "my_model-2");
        // 连续非法字符压成一个，不留下 `a---b`
        assert_eq!(normalize_dir_name("a @ # b"), "a-b");
        // 全是非法字符时有个能用的回落，交给调用方去解重名
        assert_eq!(normalize_dir_name("模型"), "model");
        assert_eq!(normalize_dir_name(""), "model");
        // 首尾不留分隔符
        assert_eq!(normalize_dir_name("  spaced  "), "spaced");
    }

    #[test]
    fn normalized_names_always_pass_the_safety_check() {
        // 清洗的产物必须满足安装链路的校验，否则清洗完照样装不进去
        for raw in ["yoyo - b", "模型", "", "a @ # b", "  x  ", &"n".repeat(200), "...", "-_-"] {
            let name = normalize_dir_name(raw);
            assert!(crate::config::is_safe_dir_name(&name), "{raw:?} → {name:?} 没通过校验");
        }
    }

    fn write_model(dir: &std::path::Path, expressions: Option<Value>) {
        let mut refs = serde_json::Map::new();
        refs.insert("Moc".to_owned(), json!("m.moc3"));
        refs.insert("Textures".to_owned(), json!(["t.png"]));
        if let Some(list) = expressions { refs.insert("Expressions".to_owned(), list); }
        fs::write(dir.join("m.model3.json"),
            serde_json::to_string(&json!({ "Version": 3, "FileReferences": refs })).unwrap()).unwrap();
    }

    #[test]
    fn registers_expression_files_the_model3_never_declared() {
        let dir = scratch("exp");
        write_model(&dir, None);
        for name in ["star", "lei", "qi"] { fs::write(dir.join(format!("{name}.exp3.json")), "{}").unwrap(); }

        let report = clean_model(&dir).unwrap();
        assert_eq!(report.registered_expressions, 3);

        let value: Value = serde_json::from_str(&fs::read_to_string(dir.join("m.model3.json")).unwrap()).unwrap();
        let list = value["FileReferences"]["Expressions"].as_array().unwrap();
        assert_eq!(list.len(), 3);
        // 名字取文件名去后缀 —— 与 VTube Studio 热键里的名字一致
        assert_eq!(list[0]["Name"], "lei");
        assert_eq!(list[0]["File"], "lei.exp3.json");
        assert!(dir.join("m.model3.json.orig").is_file(), "必须留下原始备份");
        assert!(is_clean(&dir));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn never_touches_what_the_author_already_declared() {
        let dir = scratch("declared");
        write_model(&dir, Some(json!([{ "Name": "作者起的名", "File": "star.exp3.json" }])));
        for name in ["star", "lei"] { fs::write(dir.join(format!("{name}.exp3.json")), "{}").unwrap(); }

        let report = clean_model(&dir).unwrap();
        assert_eq!(report.registered_expressions, 1, "只该补 lei，star 已经声明过");

        let value: Value = serde_json::from_str(&fs::read_to_string(dir.join("m.model3.json")).unwrap()).unwrap();
        let list = value["FileReferences"]["Expressions"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["Name"], "作者起的名", "作者声明的条目必须原样保留");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn recleaning_rebuilds_from_the_original_instead_of_stacking() {
        // 反复安装/重洗同一个模型，结果必须一样 —— 否则清单会越叠越长
        let dir = scratch("idempotent");
        write_model(&dir, None);
        for name in ["star", "lei"] { fs::write(dir.join(format!("{name}.exp3.json")), "{}").unwrap(); }

        assert_eq!(clean_model(&dir).unwrap().registered_expressions, 2);
        assert_eq!(clean_model(&dir).unwrap().registered_expressions, 2);
        assert_eq!(clean_model(&dir).unwrap().registered_expressions, 2);

        let value: Value = serde_json::from_str(&fs::read_to_string(dir.join("m.model3.json")).unwrap()).unwrap();
        assert_eq!(value["FileReferences"]["Expressions"].as_array().unwrap().len(), 2, "不该叠加");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_model_without_expression_files_is_left_alone() {
        let dir = scratch("noexp");
        write_model(&dir, None);
        let report = clean_model(&dir).unwrap();
        assert_eq!(report.registered_expressions, 0);
        assert!(!dir.join("m.model3.json.orig").exists(), "没东西可补就不该留备份");
        assert!(is_clean(&dir), "没补东西也要打标记，否则每次扫描都会重洗一遍");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn normalizes_the_directories_on_the_way_to_a_nested_model() {
        // 官方下载包的形状：包名/模型名/runtime/x.model3.json，而中间层带空格
        let root = scratch("nested");
        let deep = root.join("my pack").join("char one").join("runtime");
        fs::create_dir_all(&deep).unwrap();
        write_model(&deep, None);
        fs::write(deep.join("star.exp3.json"), "{}").unwrap();
        // 贴图目录带点，是被 model3.json 按名字引用的 —— 绝不能被改名
        fs::create_dir_all(deep.join("m.4096")).unwrap();
        fs::write(deep.join("m.4096").join("t.png"), "x").unwrap();

        let report = clean_tree(&root, 4).unwrap();
        assert_eq!(report.registered_expressions, 1);

        let fixed = root.join("my-pack").join("char-one").join("runtime");
        assert!(fixed.join("m.model3.json").is_file(), "路径上的目录应已改名");
        assert!(fixed.join("m.4096").join("t.png").is_file(), "模型内部的贴图目录必须原样保留");
        assert!(!root.join("my pack").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn cleans_every_character_in_a_multi_character_pack() {
        // 一个包里两个角色（tororo_hijiki_ja 那种），两个都要清洗到
        let root = scratch("multi");
        for who in ["tororo", "hijiki"] {
            let dir = root.join("pack").join(who);
            fs::create_dir_all(&dir).unwrap();
            write_model(&dir, None);
            fs::write(dir.join("a.exp3.json"), "{}").unwrap();
        }
        let report = clean_tree(&root, 4).unwrap();
        assert_eq!(report.registered_expressions, 2, "两个角色各补一个");
        for who in ["tororo", "hijiki"] {
            assert!(is_clean(&root.join("pack").join(who)));
        }
        fs::remove_dir_all(&root).unwrap();
    }

    fn write_motion(dir: &std::path::Path, rel: &str) {
        let full = dir.join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, "{}").unwrap();
    }

    #[test]
    fn registers_motion_files_the_model3_never_declared() {
        let dir = scratch("mot");
        write_model(&dir, None);
        for f in ["motions/a.motion3.json", "motions/b.motion3.json"] { write_motion(&dir, f); }

        let report = clean_model(&dir).unwrap();
        assert_eq!(report.registered_motions, 2);

        let value: Value = serde_json::from_str(&fs::read_to_string(dir.join("m.model3.json")).unwrap()).unwrap();
        let idle = value["FileReferences"]["Motions"]["Idle"].as_array().unwrap();
        assert_eq!(idle.len(), 2);
        // 路径要相对 model3.json，带上 motions/ 这一层，否则库取不到
        assert_eq!(idle[0]["File"], "motions/a.motion3.json");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn uses_the_authors_hotkeys_to_skip_mouse_tracking_curves() {
        // CandyBoy 的真实形状：motions/ 里九个热键动作 + mousex/mousey 两条鼠标跟随曲线。
        // 后者当动作播出来就是乱抖，而热键表是唯一能区分它们的依据。
        let dir = scratch("vtube");
        write_model(&dir, None);
        for f in ["motions/q.motion3.json", "motions/w.motion3.json",
                  "motions/mousex.motion3.json", "motions/mousey.motion3.json"] { write_motion(&dir, f); }
        fs::write(dir.join("m.vtube.json"), serde_json::to_string(&json!({ "Hotkeys": [
            { "Action": "TriggerAnimation", "File": "q.motion3.json" },
            { "Action": "TriggerAnimation", "File": "w.motion3.json" },
            { "Action": "ToggleExpression", "File": "hair.exp3.json" },
        ]})).unwrap()).unwrap();

        let report = clean_model(&dir).unwrap();
        assert_eq!(report.registered_motions, 2, "只该收 q 和 w");

        let value: Value = serde_json::from_str(&fs::read_to_string(dir.join("m.model3.json")).unwrap()).unwrap();
        let files: Vec<String> = value["FileReferences"]["Motions"]["Idle"].as_array().unwrap()
            .iter().map(|item| item["File"].as_str().unwrap().to_owned()).collect();
        assert_eq!(files, vec!["motions/q.motion3.json", "motions/w.motion3.json"]);
        assert!(!files.iter().any(|f| f.contains("mouse")), "鼠标跟随曲线不该被当成动作");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn leaves_the_authors_own_motion_groups_completely_alone() {
        // 作者分好组就是作者意图（哪几个算 Idle、哪几个算 TapBody），我们没有依据去改
        let dir = scratch("declaredmot");
        let mut refs = serde_json::Map::new();
        refs.insert("Moc".to_owned(), json!("m.moc3"));
        refs.insert("Textures".to_owned(), json!(["t.png"]));
        refs.insert("Motions".to_owned(), json!({ "TapBody": [{ "File": "motions/tap.motion3.json" }] }));
        fs::write(dir.join("m.model3.json"),
            serde_json::to_string(&json!({ "Version": 3, "FileReferences": refs })).unwrap()).unwrap();
        write_motion(&dir, "motions/tap.motion3.json");
        write_motion(&dir, "motions/unlisted.motion3.json");

        let report = clean_model(&dir).unwrap();
        assert_eq!(report.registered_motions, 0, "作者已分组就一条都不补");

        let value: Value = serde_json::from_str(&fs::read_to_string(dir.join("m.model3.json")).unwrap()).unwrap();
        let motions = value["FileReferences"]["Motions"].as_object().unwrap();
        assert_eq!(motions.keys().collect::<Vec<_>>(), vec!["TapBody"], "不该多出 Idle 组");
        fs::remove_dir_all(&dir).unwrap();
    }
}
