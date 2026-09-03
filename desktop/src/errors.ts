import type { Language } from "./prefs";

/**
 * Rust 侧返回的错误代号 → 用户能读懂的话。
 *
 * **为什么措辞在这边**：界面语言存在前端（config.json 的 `language`），Rust 不知道现在是中文
 * 还是英文。原来那些串是中文写死的，英文界面下会突然蹦出一句中文。代号清单的单一真相在
 * `src-tauri/src/lib.rs` 的 `user_error`，这里逐个给两句话（有测试对表）。
 *
 * `detail` 是代号后面用 `|` 带出来的东西（文件夹名、命令回显），由这里决定怎么摆进句子。
 */
type Phrase = (detail: string) => string;

const MESSAGES: Record<Language, Record<string, Phrase>> = {
  "zh-CN": {
    archive: () => "这是压缩包：请先双击解压，再把解压出来的文件夹拖进来。",
    "not-a-folder": () => "请拖入模型所在的文件夹，不是单个文件。",
    "bad-name": name => `文件夹名“${name}”不能用作模型名：请改成只含字母、数字、- 或 _。`,
    "no-model3": () => "这个文件夹里（含下两层子目录）没有 *.model3.json，不是 Cubism 模型目录。",
    "already-installed": name => `已经装过“${name}”了：先在模型文件夹里删掉它再重装。`,
    "too-large": () => "这个文件夹太大了，看起来不像一个模型目录。",
    "unknown-model": () => "找不到这个已安装模型，列表可能已经变了；重开设置再试。",
  },
  en: {
    archive: () => "That is an archive: extract it first, then drag in the extracted folder.",
    "not-a-folder": () => "Drag in the folder that holds the model, not a single file.",
    "bad-name": name => `The folder name “${name}” cannot be used as a model name: use only letters, numbers, - or _.`,
    "no-model3": () => "No *.model3.json in this folder (searched two levels down), so it is not a Cubism model folder.",
    "already-installed": name => `“${name}” is already installed: delete it from the models folder before reinstalling.`,
    "too-large": () => "That folder is too large to be a model folder.",
    "unknown-model": () => "That installed model is gone — the list may have changed. Reopen Settings and try again.",
  },
};

/**
 * 把 `invoke` 抛出的东西变成一句人话。
 *
 * **认不出的一律原样显示**：漏翻一个代号只是文案不够漂亮，而吞掉它会变成一片空白 ——
 * 那才是真正查不下去的失败（本项目吃过一次亏，见 connectors.ts 里那条 `.catch(() => [])`）。
 */
export function errorMessage(error: unknown, locale: Language): string {
  const raw = String((error as { message?: string })?.message ?? error).trim();
  const cut = raw.indexOf("|");
  const code = cut === -1 ? raw : raw.slice(0, cut);
  const detail = cut === -1 ? "" : raw.slice(cut + 1).trim();
  const phrase = MESSAGES[locale][code];
  return phrase ? phrase(detail) : raw;
}

/** 测试用：代号清单要与 Rust 的 `user_error::ALL` 对得上。 */
export const ERROR_CODES = Object.keys(MESSAGES["zh-CN"]);
