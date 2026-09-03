import { SEMANTIC_STATES, type SemanticState } from "./types";
import type { Language } from "./prefs";

/**
 * 状态栏上那几个词。
 *
 * writing / researching 默认都叫「思考中」：工具一闪而过时两者会来回跳，合成一个词
 * 就不抖了。内部语义与表情映射仍然分开 —— 合并的只是**显示**。
 * syncing 原来还挤着「等另一个 agent」和「同步外部服务」，那两件事已经拆成 awaiting 和
 * syncing 各自一档，标签也跟着分开。
 *
 * 状态栏是这个应用唯一常驻可见的文字，跟界面语言走；日志里记的仍是内部语义，不受影响。
 */
export const STATE_LABELS: Record<Language, Record<string, string>> = {
  "zh-CN": {
    idle: "空闲", writing: "思考中", researching: "思考中",
    executing: "执行中", awaiting: "等待中", reviewing: "审阅中",
    syncing: "同步中", error: "出错",
  },
  en: {
    // 首字母大写：状态栏与窗口标题都用它（`Agent Avatar · Thinking`），
    // 而设置页的英文状态名同样是大写开头，两处必须一致
    idle: "Idle", writing: "Thinking", researching: "Thinking",
    executing: "Executing", awaiting: "Awaiting", reviewing: "Reviewing",
    syncing: "Syncing", error: "Error",
  },
};

/**
 * 用户改过的显示名优先。
 *
 * 🔴 **不分语言存一份。** 「出错」改叫「生气中」是用户给自己的形象起的名字，不是一条
 * 待翻译的界面文案 —— 切到英文界面还硬翻回 "Error" 等于把他的设置吞了。空白（或只有
 * 空格）当作没改，回落到内置文案，所以清空输入框就是「恢复默认」，不需要额外的按钮。
 */
export function stateLabel(state: string, locale: Language, aliases: Partial<Record<SemanticState, string>> = {}): string {
  const custom = aliases[state as SemanticState]?.trim();
  return custom || STATE_LABELS[locale][state] || state;
}

/** 存进配置前先过一遍：空白丢掉、不认识的状态丢掉、太长的截断。 */
export function cleanStateLabels(raw: unknown): Partial<Record<SemanticState, string>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<Record<SemanticState, string>> = {};
  for (const [state, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SEMANTIC_STATES as readonly string[]).includes(state)) continue;
    if (typeof value !== "string") continue;
    // 状态栏是一行，长了会把手动触发提示和穿透提示挤出去 —— 在存的这一步就挡住
    const text = value.trim().slice(0, 24);
    if (text) out[state as SemanticState] = text;
  }
  return out;
}
