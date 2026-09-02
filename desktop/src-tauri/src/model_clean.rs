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
pub const CLEANER_VERSION: u32 = 5;

/// 清洗留下的标记文件。点开头 —— `list_model_issues` 会跳过点开头的条目，不会把它当成坏模型报出来。
pub const MARKER: &str = ".agent-avatar-clean.json";

#[derive(Debug, Default, PartialEq)]
pub struct CleanReport {
    /// 这次补登记了几个表情（已经声明过的不计）。
    pub registered_expressions: usize,
    /// 这次补登记了几个动作（作者已经分过组时恒为 0）。
    pub registered_motions: usize,
    /// 这次补上了几个空着的参数组（LipSync / EyeBlink）。
    pub filled_groups: usize,
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

/// 模型里**实际存在**的参数 ID，取自 `*.cdi3.json`（Cubism 导出的显示信息）。
/// 没有这个文件时返回 None —— 调用方据此决定是照标准补还是不动。
fn parameter_ids(dir: &Path) -> Option<Vec<String>> {
    let cdi = fs::read_dir(dir).ok()?.flatten().map(|e| e.path())
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".cdi3.json")))?;
    let value: Value = serde_json::from_str(&fs::read_to_string(cdi).ok()?).ok()?;
    Some(value.get("Parameters")?.as_array()?.iter()
        .filter_map(|item| item.get("Id")?.as_str().map(str::to_owned))
        .collect())
}

/// 目录**本层**里以某后缀结尾的文件名，排序后返回。
///
/// 与 `register_assets` 里那段就地扫描的区别：那边读目录失败要当错误往上抛（模型都读不了），
/// 这里只是取名字，读不到就当没有 —— 别名缺一个不影响任何功能。
fn list_files(dir: &Path, suffix: &str) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(dir).into_iter().flatten().flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| name.ends_with(suffix))
        .collect();
    out.sort();
    out
}

/// `*.cdi3.json` 里每个参数的显示名与所属分组：`Param70` → (`兽耳`, `隐藏`)。
///
/// 分组是作者自己的分类，界面按它把开关分块。boy8 分了「隐藏 / 表情 / 动作」三组，
/// 第三组其实是道具（酒、麦克风、手机）—— 作者管它叫动作，但它们是叠加型开关不是 motion。
/// CandyBoy 把 34 项全塞在一个 `KEY` 组里，也就是没分类，界面照实显示成一整组。
fn parameter_groups(dir: &Path) -> std::collections::HashMap<String, (Option<String>, Option<String>)> {
    let Some(cdi) = fs::read_dir(dir).ok().into_iter().flatten().flatten().map(|e| e.path())
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".cdi3.json"))) else {
        return Default::default();
    };
    let Ok(value) = fs::read_to_string(cdi).map_err(|_| ()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|_| ())) else {
        return Default::default();
    };
    let groups: std::collections::HashMap<&str, &str> = value.get("ParameterGroups").and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|g| Some((g.get("Id")?.as_str()?, g.get("Name")?.as_str()?))).collect())
        .unwrap_or_default();
    value.get("Parameters").and_then(Value::as_array).map(|list| list.iter()
        .filter_map(|item| {
            let id = item.get("Id")?.as_str()?;
            // Cubism 导出时会给没起名的参数把 Name 填成 Id 本身，那种当别名等于没起
            let name = item.get("Name").and_then(Value::as_str).filter(|n| !n.is_empty() && *n != id);
            let group = item.get("GroupId").and_then(Value::as_str).and_then(|g| groups.get(g)).copied();
            Some((id.to_owned(), (name.map(str::to_owned), group.map(str::to_owned))))
        }).collect()).unwrap_or_default()
}

/// 作者给参数起的显示名，`parameter_groups` 的名字那一半。
///
/// 只收**和 Id 不同**的那些 —— Cubism 导出时会给没起名的参数把 Name 填成 Id 本身
///（CandyBoy 有一半是 `Key13` → `Key13`），那种当别名等于没起。
fn parameter_names(dir: &Path) -> std::collections::HashMap<String, String> {
    parameter_groups(dir).into_iter().filter_map(|(id, (name, _))| Some((id, name?))).collect()
}

/// `*.vtube.json` 里作者给热键起的名字：`hair.exp3.json` → `hair`。返回 文件名 → 名字。
fn hotkey_names(dir: &Path) -> std::collections::HashMap<String, String> {
    let Some(vtube) = fs::read_dir(dir).ok().into_iter().flatten().flatten().map(|e| e.path())
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".vtube.json"))) else {
        return Default::default();
    };
    let Ok(value) = fs::read_to_string(vtube).map_err(|_| ()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|_| ())) else {
        return Default::default();
    };
    value.get("Hotkeys").and_then(Value::as_array).map(|list| list.iter()
        .filter_map(|hotkey| {
            let file = hotkey.get("File")?.as_str()?;
            let name = hotkey.get("Name")?.as_str()?;
            (!name.is_empty()).then(|| (file.to_owned(), name.to_owned()))
        }).collect()).unwrap_or_default()
}

/// 作者给每个表情/动作起的**人话名字**，供设置页当默认别名用。键是文件名主干。
///
/// 为什么值得在导入时算好：第三方模型的文件名基本不能看 —— boy8 的表情叫 `Q`/`F1`/`F7`，
/// CandyBoy 的叫 `0`/`1111`/`2222333`。而作者其实起过名，只是散在两个地方：
///
/// 1. **`.cdi3.json` 的参数名** —— 最好的来源。boy8 的 `Q.exp3.json` 只改一个参数 `Param70`，
///    而 cdi3 说 `Param70` 叫「兽耳」。20 个表情它起全了 20 个。
/// 2. **`.vtube.json` 的热键名** —— 次选。CandyBoy 靠它拿到 `hair`/`bag1`/`frog`/`hello`。
///
/// 两个都取不到就不写，设置页那一格留空，由用户自己填（第三方模型里确实有一批作者没起名）。
fn display_names(dir: &Path) -> Value {
    let parameters = parameter_names(dir);
    let hotkeys = hotkey_names(dir);
    let mut out = serde_json::Map::new();
    for file in list_files(dir, ".exp3.json").into_iter().chain(motion_files(dir)) {
        let stem = file.rsplit('/').next().unwrap_or(&file)
            .trim_end_matches(".exp3.json").trim_end_matches(".motion3.json").to_owned();
        // 单参数表情：那个参数的名字就是这个零件的名字
        let from_parameter = single_parameter_id(&dir.join(&file)).and_then(|id| parameters.get(&id).cloned());
        if let Some(name) = from_parameter.or_else(|| hotkeys.get(&file).cloned()) {
            if name != stem { out.insert(stem, Value::String(name)); }
        }
    }
    Value::Object(out)
}

/// 可以「常驻」的开关：只改一个参数、且 Blend 为 Add 的表情。
///
/// 为什么这是判据：这类表情就是一个开关（`{"Id":"Param70","Value":1.0,"Blend":"Add"}`），
/// 直接写参数就能一直按住，而且**互不干扰** —— 2026-09-02 实测 酒 + 麦克风 + 生气 + 星星 +
/// 爱心 + 兽耳 同时开，六样全都画出来，谁也没顶掉谁。多参数的那种是「一整张脸」，
/// 走表情管理器，机制上一次只能挂一个，做不到常驻叠加。
///
/// 值得记一句：**没有任何冲突需要程序去检测**。道具组的项叠起来会挤在同一只手上，
/// 但那是显示体验的事，不是逻辑冲突；而「哪两项占用同一个身体部位」模型里没有任何数据记录，
/// 按组去猜互斥反而会禁掉真实用法（隐藏组的 头 + 身体 + 兽耳 同时开正是要的）。所以不猜。
///
/// 产物形如 `{"Q": {"param": "Param70", "group": "隐藏"}}`，键是文件名主干。
fn switches(dir: &Path) -> Value {
    let parameters = parameter_groups(dir);
    let mut out = serde_json::Map::new();
    for file in list_files(dir, ".exp3.json") {
        let Some(id) = single_add_parameter(&dir.join(&file)) else { continue };
        let group = parameters.get(&id).and_then(|(_, group)| group.clone());
        let stem = file.trim_end_matches(".exp3.json").to_owned();
        out.insert(stem, json!({ "param": id, "group": group }));
    }
    Value::Object(out)
}

/// 表情只改一个参数时返回那个参数 ID。多参数的是「一张脸」，没有单一的名字可取。
fn single_parameter_id(path: &Path) -> Option<String> {
    let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let list = value.get("Parameters")?.as_array()?;
    (list.len() == 1).then(|| list[0].get("Id")?.as_str().map(str::to_owned)).flatten()
}

/// 同上，但还要求 `Blend` 是 `Add` —— 只有加法叠加的那种按住才有意义，
/// `Overwrite` 会把动作算出来的值整个盖掉。
fn single_add_parameter(path: &Path) -> Option<String> {
    let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let list = value.get("Parameters")?.as_array()?;
    if list.len() != 1 { return None; }
    (list[0].get("Blend").and_then(Value::as_str) == Some("Add"))
        .then(|| list[0].get("Id")?.as_str().map(str::to_owned)).flatten()
}

/// 补上空着的 `Groups` 条目（`LipSync` / `EyeBlink`），返回补了几组。
///
/// **为什么需要**：面捕向的模型普遍把这两组留空 —— VTube Studio 自己管口型与眨眼的映射，
/// 不写 Cubism 的这一栏。而 Cubism 运行时只认这里：组是空的，它就不知道该驱动哪个参数，
/// 于是**嘴一动不动、眼也不眨**，而且没有任何报错。实测四个模型里三个 LipSync 是空的，
/// 其中一个连 EyeBlink 也是空的。
///
/// 只在**该组不存在或为空**时补；作者写了什么就一个字不动。
/// 参数名用 Cubism 的标准 ID，并且只补模型里确实有的那些（有 cdi3 时逐个核对）。
fn register_groups(value: &mut Value, dir: &Path) -> usize {
    const LIP_SYNC: [&str; 1] = ["ParamMouthOpenY"];
    const EYE_BLINK: [&str; 2] = ["ParamEyeLOpen", "ParamEyeROpen"];
    let existing = parameter_ids(dir);
    let mut filled = 0;

    for (name, wanted) in [("LipSync", &LIP_SYNC[..]), ("EyeBlink", &EYE_BLINK[..])] {
        // 模型里没有的参数不补 —— 硬塞一个不存在的 ID 只会让人以为已经修好了。
        // 拿不到 cdi3 时按标准补：Cubism 运行时会忽略不认识的 ID，代价只是白写一条。
        let ids: Vec<String> = wanted.iter()
            .filter(|id| existing.as_ref().is_none_or(|have| have.iter().any(|p| p == *id)))
            .map(|id| (*id).to_owned())
            .collect();
        if ids.is_empty() { continue; }

        let groups = value.get_mut("Groups").and_then(Value::as_array_mut);
        let Some(groups) = groups else {
            value["Groups"] = json!([{ "Target": "Parameter", "Name": name, "Ids": ids }]);
            filled += 1;
            continue;
        };
        match groups.iter_mut().find(|g| g.get("Name").and_then(Value::as_str) == Some(name)) {
            Some(group) => {
                let empty = group.get("Ids").and_then(Value::as_array).is_none_or(|list| list.is_empty());
                if empty { group["Ids"] = json!(ids); filled += 1; }
            }
            None => {
                groups.push(json!({ "Target": "Parameter", "Name": name, "Ids": ids }));
                filled += 1;
            }
        }
    }
    filled
}

/// 把目录里没被 `model3.json` 声明的表情与动作补登记进去。返回（表情数, 动作数）。
///
/// 表情与动作**必须在同一次读写里做完**：两者都从 `.orig` 重建，分两次写的话
/// 后一次会把前一次的成果冲掉。
fn register_assets(dir: &Path) -> Result<(usize, usize, usize), String> {
    let Some(model3) = model3_in(dir) else { return Ok((0, 0, 0)) };
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

    // 参数组要在表情/动作之后补：三者共用同一次读写。
    let groups = register_groups(&mut value, dir);

    if expressions == 0 && motions == 0 && groups == 0 { return Ok((0, 0, 0)); }

    // 先备份再写。备份只在第一次建 —— 它记的是「作者原始的样子」。
    if !backup.is_file() {
        fs::copy(&model3, &backup).map_err(|error| error.to_string())?;
    }
    fs::write(&model3, serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    Ok((expressions, motions, groups))
}

/// 已经按当前规则清洗过了吗。
pub fn is_clean(dir: &Path) -> bool {
    fs::read_to_string(dir.join(MARKER)).ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("cleanerVersion")?.as_u64())
        .is_some_and(|version| version >= CLEANER_VERSION as u64)
}

/// 从标记文件里读回清洗时算好的某个对象（`displayNames` / `switches`）。读不到就返回空对象。
pub fn read_marker_object(dir: &Path, field: &str) -> Value {
    fs::read_to_string(dir.join(MARKER)).ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get(field).cloned())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// 清洗一个**模型目录**（它自己就含 `model3.json`）。
pub fn clean_model(dir: &Path) -> Result<CleanReport, String> {
    let (registered_expressions, registered_motions, filled_groups) = register_assets(dir)?;
    let marker = json!({ "cleanerVersion": CLEANER_VERSION,
        "registeredExpressions": registered_expressions, "registeredMotions": registered_motions,
        "filledGroups": filled_groups, "displayNames": display_names(dir), "switches": switches(dir) });
    fs::write(dir.join(MARKER), serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?)
        .map_err(|error| error.to_string())?;
    Ok(CleanReport { registered_expressions, registered_motions, filled_groups })
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
        report.filled_groups += one.filled_groups;
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

    /// 作者起的名字散在两个文件里，两个都得认，而且 cdi3 优先。
    #[test]
    fn display_names_prefer_the_parameter_name_then_the_hotkey_name() {
        let dir = scratch("names");
        write_model(&dir, None);
        // 单参数表情 + cdi3 给了这个参数一个名字 → 用「兽耳」
        fs::write(dir.join("Q.exp3.json"),
            r#"{"Parameters":[{"Id":"Param70","Value":1.0,"Blend":"Add"}]}"#).unwrap();
        // 单参数，但 cdi3 里这个参数的 Name 就等于 Id → 不算起过名，退到 vtube
        fs::write(dir.join("hair.exp3.json"),
            r#"{"Parameters":[{"Id":"Key13","Value":1.0,"Blend":"Add"}]}"#).unwrap();
        // 多参数 = 一张脸，没有单一参数可取名，且 vtube 也没写 → 不收
        fs::write(dir.join("face.exp3.json"),
            r#"{"Parameters":[{"Id":"A","Value":1.0},{"Id":"B","Value":1.0}]}"#).unwrap();
        fs::write(dir.join("m.cdi3.json"), serde_json::to_string(&json!({
            "Parameters": [{ "Id": "Param70", "Name": "兽耳" }, { "Id": "Key13", "Name": "Key13" }]
        })).unwrap()).unwrap();
        fs::write(dir.join("m.vtube.json"), serde_json::to_string(&json!({
            "Hotkeys": [{ "File": "hair.exp3.json", "Name": "换发型" },
                        { "File": "Q.exp3.json", "Name": "别用这个" }]
        })).unwrap()).unwrap();

        let names = display_names(&dir);
        assert_eq!(names["Q"], "兽耳", "cdi3 的参数名应当压过 vtube 的热键名");
        assert_eq!(names["hair"], "换发型", "cdi3 把 Name 填成 Id 时不算起过名，该退到 vtube");
        assert!(names.get("face").is_none(), "多参数表情没有单一参数可取名");
        fs::remove_dir_all(&dir).ok();
    }

    /// 判据是「单参数 + Add」。多参数是一整张脸（走表情管理器，一次只能一个），
    /// Overwrite 会把动作算出来的值整个盖掉，两种都不能按住。
    #[test]
    fn switches_are_single_add_parameter_expressions_with_their_group() {
        let dir = scratch("switches");
        write_model(&dir, None);
        fs::write(dir.join("Q.exp3.json"), r#"{"Parameters":[{"Id":"Param70","Value":1.0,"Blend":"Add"}]}"#).unwrap();
        fs::write(dir.join("N1.exp3.json"), r#"{"Parameters":[{"Id":"Param54","Value":1.0,"Blend":"Add"}]}"#).unwrap();
        fs::write(dir.join("face.exp3.json"), r#"{"Parameters":[{"Id":"A","Value":1.0,"Blend":"Add"},{"Id":"B","Value":1.0,"Blend":"Add"}]}"#).unwrap();
        fs::write(dir.join("over.exp3.json"), r#"{"Parameters":[{"Id":"C","Value":1.0,"Blend":"Overwrite"}]}"#).unwrap();
        fs::write(dir.join("m.cdi3.json"), serde_json::to_string(&json!({
            "Parameters": [{ "Id": "Param70", "Name": "兽耳", "GroupId": "G1" },
                           { "Id": "Param54", "Name": "酒", "GroupId": "G2" }],
            "ParameterGroups": [{ "Id": "G1", "Name": "隐藏" }, { "Id": "G2", "Name": "动作" }]
        })).unwrap()).unwrap();

        let out = switches(&dir);
        assert_eq!(out["Q"]["param"], "Param70");
        assert_eq!(out["Q"]["group"], "隐藏");
        assert_eq!(out["N1"]["group"], "动作");
        assert!(out.get("face").is_none(), "多参数是一整张脸，不能常驻叠加");
        assert!(out.get("over").is_none(), "Overwrite 会盖掉动作，按住它没有意义");
        fs::remove_dir_all(&dir).ok();
    }

    /// 作者没分组时组名为空，界面把这些归到「其他」，而不是凭空造一个分类。
    #[test]
    fn a_switch_without_a_group_reports_none() {
        let dir = scratch("switches-nogroup");
        write_model(&dir, None);
        fs::write(dir.join("k.exp3.json"), r#"{"Parameters":[{"Id":"K1","Value":1.0,"Blend":"Add"}]}"#).unwrap();
        assert_eq!(switches(&dir)["k"]["group"], Value::Null);
        fs::remove_dir_all(&dir).ok();
    }

    /// 名字和文件名一样时不写进去 —— 那是噪音，设置页会拿文件名兜底。
    #[test]
    fn display_names_skip_a_name_that_just_repeats_the_file_name() {
        let dir = scratch("names-noop");
        write_model(&dir, None);
        fs::write(dir.join("hello.exp3.json"), r#"{"Parameters":[{"Id":"K1","Value":1.0}]}"#).unwrap();
        fs::write(dir.join("m.cdi3.json"), serde_json::to_string(&json!({
            "Parameters": [{ "Id": "K1", "Name": "hello" }]
        })).unwrap()).unwrap();
        assert!(display_names(&dir).as_object().unwrap().is_empty());
        fs::remove_dir_all(&dir).ok();
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
    fn a_model_without_expression_files_gets_no_expressions() {
        let dir = scratch("noexp");
        write_model(&dir, None);
        let report = clean_model(&dir).unwrap();
        assert_eq!(report.registered_expressions, 0);
        assert!(is_clean(&dir), "没补表情也要打标记，否则每次扫描都会重洗一遍");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn fills_the_empty_lip_sync_and_blink_groups_that_stop_the_mouth_moving() {
        // 实测踩到的：面捕向的模型普遍把这两组留空（VTube Studio 自己管映射，不写 Cubism 这栏）。
        // 组是空的，Cubism 运行时就不知道该驱动哪个参数 —— 嘴一动不动、眼也不眨，且毫无报错。
        // 四个实测模型里三个 LipSync 是空的，其中一个连 EyeBlink 也是空的。
        let dir = scratch("groups");
        fs::write(dir.join("m.model3.json"), serde_json::to_string(&json!({
            "Version": 3,
            "FileReferences": { "Moc": "m.moc3", "Textures": ["t.png"] },
            "Groups": [{ "Target": "Parameter", "Name": "LipSync", "Ids": [] },
                       { "Target": "Parameter", "Name": "EyeBlink", "Ids": [] }],
        })).unwrap()).unwrap();
        // 参数确实存在于模型里，只是没登记
        fs::write(dir.join("m.cdi3.json"), serde_json::to_string(&json!({
            "Parameters": [{ "Id": "ParamMouthOpenY" }, { "Id": "ParamEyeLOpen" }, { "Id": "ParamEyeROpen" }],
        })).unwrap()).unwrap();

        assert_eq!(clean_model(&dir).unwrap().filled_groups, 2);
        let value: Value = serde_json::from_str(&fs::read_to_string(dir.join("m.model3.json")).unwrap()).unwrap();
        let groups: Vec<(&str, Vec<&str>)> = value["Groups"].as_array().unwrap().iter()
            .map(|g| (g["Name"].as_str().unwrap(),
                      g["Ids"].as_array().unwrap().iter().map(|i| i.as_str().unwrap()).collect()))
            .collect();
        assert!(groups.contains(&("LipSync", vec!["ParamMouthOpenY"])));
        assert!(groups.contains(&("EyeBlink", vec!["ParamEyeLOpen", "ParamEyeROpen"])));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn never_rewrites_groups_the_author_already_filled_in() {
        let dir = scratch("authorgroups");
        fs::write(dir.join("m.model3.json"), serde_json::to_string(&json!({
            "Version": 3,
            "FileReferences": { "Moc": "m.moc3", "Textures": ["t.png"] },
            "Groups": [{ "Target": "Parameter", "Name": "LipSync", "Ids": ["SomeCustomMouth"] }],
        })).unwrap()).unwrap();
        fs::write(dir.join("m.cdi3.json"), serde_json::to_string(&json!({
            "Parameters": [{ "Id": "ParamMouthOpenY" }, { "Id": "SomeCustomMouth" }],
        })).unwrap()).unwrap();

        // LipSync 作者写了就不动；EyeBlink 缺失且模型没有眼参数，也不该硬塞
        assert_eq!(clean_model(&dir).unwrap().filled_groups, 0);
        let value: Value = serde_json::from_str(&fs::read_to_string(dir.join("m.model3.json")).unwrap()).unwrap();
        assert_eq!(value["Groups"][0]["Ids"][0], "SomeCustomMouth");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_registers_parameters_the_model_actually_has() {
        // 硬塞一个模型里没有的 ID 只会让人以为已经修好了
        let dir = scratch("partial");
        fs::write(dir.join("m.model3.json"), serde_json::to_string(&json!({
            "Version": 3,
            "FileReferences": { "Moc": "m.moc3", "Textures": ["t.png"] },
            "Groups": [{ "Target": "Parameter", "Name": "EyeBlink", "Ids": [] }],
        })).unwrap()).unwrap();
        fs::write(dir.join("m.cdi3.json"), serde_json::to_string(&json!({
            "Parameters": [{ "Id": "ParamEyeLOpen" }],   // 只有左眼，没有右眼、没有嘴
        })).unwrap()).unwrap();

        clean_model(&dir).unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(dir.join("m.model3.json")).unwrap()).unwrap();
        let groups = value["Groups"].as_array().unwrap();
        let blink = groups.iter().find(|g| g["Name"] == "EyeBlink").unwrap();
        assert_eq!(blink["Ids"].as_array().unwrap().len(), 1, "只该补模型里真有的那个");
        assert!(!groups.iter().any(|g| g["Name"] == "LipSync"), "模型没有嘴参数就不该凭空造出 LipSync 组");
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
