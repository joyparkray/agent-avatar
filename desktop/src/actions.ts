import { motionKey, motionRefs, type ModelInventory, type MotionRef } from "./inventory";

/**
 * 「可触发的一项」—— 表情和动作在设置里合成了一张表，这里是那张表的行模型。
 *
 * 为什么合成一张：从用户的角度，单击、双击、`Ctrl+X` 是同一类东西（触发方式），
 * 表情和动作是同一类东西（被触发的内容）。原来分两张表、各带一个「单击」列和一个「双击」列，
 * 等于把一个二维关系拆成了四个复选框，用户得自己在脑子里拼回去。
 */
export type ActionKind = "expression" | "motion";

/**
 * 触发方式。`click` / `dblclick` 是点人物，其余字符串是全局快捷键（`Ctrl+Shift+X`）。
 * 没有条目就是「不触发」。
 *
 * **同一个触发方式绑多项 = 随机池**，这是本项目一直以来的语义，快捷键沿用它：
 * `Ctrl+X` 绑三行就是三选一，和单击绑三个表情是一回事。
 */
export type Trigger = "click" | "dblclick" | (string & {});

export const CLICK: Trigger = "click";
export const DBLCLICK: Trigger = "dblclick";

export interface ActionItem {
  /** 稳定的存储键。别名改的是显示，这个键不变，否则改个名就把触发绑定弄丢了。 */
  key: string;
  kind: ActionKind;
  /** 模型里的原名。界面最左列显示它 —— 别名改完还得能对回模型文件，否则排障时只能瞎猜。 */
  origin: string;
  /** 作者起的名字（来自 `.cdi3.json` 的参数名或 `.vtube.json` 的热键名），可能没有。 */
  authored?: string;
  /** 动作专用：播放时要用的 [组, 序号]。 */
  motion?: MotionRef;
  /**
   * 单参数开关按住的那个参数。只有带这个的项能「常驻」——
   * 多参数的表情走表情管理器，机制上一次只能挂一个，做不到叠加常驻。
   */
  hold?: string;
  /** 作者在 `.cdi3.json` 里的分类（隐藏 / 表情 / 动作…）。没分类就没有。 */
  group?: string;
}

/** 清洗时算好的开关表：文件名主干 → 按住哪个参数、属于哪一组。 */
export type SwitchTable = Record<string, { param?: string; group?: string | null }>;

export const expressionActionKey = (name: string): string => `expression:${name}`;
export const motionActionKey = (ref: MotionRef): string => `motion:${motionKey(ref)}`;

/**
 * 一个模型的全部可触发项，表情在前、动作在后。
 *
 * `displayNames` 是清洗时从模型里读出来的「作者起的名字」，键是文件名主干
 * （boy8 的 `F1` → `生气`）。取不到就留空，由界面回落到原名。
 */
export function listActions(inventory: ModelInventory, displayNames: Record<string, string> = {}, switches: SwitchTable = {}): ActionItem[] {
  const expressions = inventory.expressions.map((name): ActionItem => ({
    key: expressionActionKey(name), kind: "expression", origin: name, authored: displayNames[name],
    hold: switches[name]?.param, group: switches[name]?.group ?? undefined,
  }));
  const motions = motionRefs(inventory).map(([group, index]): ActionItem => {
    // 组名为空的模型（haru_greeter 的 27 个动作全在 "" 组里）拿文件名当原名，
    // 否则界面上会出现一排只有序号、彼此分不出来的行。
    const file = inventory.motions.find(item => item.group === group)?.files?.[index] ?? "";
    const origin = group ? `${group} ${index}` : file || `#${index}`;
    return {
      key: motionActionKey([group, index]), kind: "motion", origin,
      authored: displayNames[file], motion: [group, index],
    };
  });
  return [...expressions, ...motions];
}

/**
 * 界面上显示的名字：用户改的别名优先，其次作者起的名字，最后是原名。
 *
 * 三层而不是两层，是因为第三方模型的原名基本不能看（boy8 的表情叫 `F1`、`Q`，
 * CandyBoy 的叫 `1111`、`2222333`），而作者其实起过名，只是散在 cdi3 和 vtube.json 里。
 * 让作者的名字兜在中间，大多数模型用户一个字都不用填。
 */
export function actionLabel(item: ActionItem, aliases: Record<string, string> = {}): string {
  const alias = aliases[item.key]?.trim();
  return alias || item.authored || item.origin;
}

/** 绑在某个触发方式上的项。顺序跟 `items` 一致，随机挑选据此有稳定的候选集。 */
export function actionsFor(items: readonly ActionItem[], triggers: Record<string, Trigger>, trigger: Trigger): ActionItem[] {
  return items.filter(item => triggers[item.key] === trigger);
}

/** 用到的全部快捷键（去掉单击/双击）。注册时按这个列表来。 */
export function shortcutsIn(triggers: Record<string, Trigger>): string[] {
  const seen = new Set<string>();
  for (const trigger of Object.values(triggers)) {
    if (trigger && trigger !== CLICK && trigger !== DBLCLICK) seen.add(trigger);
  }
  return [...seen];
}

/**
 * 从候选里随机挑一个；`avoid` 是上一次挑中的键，用来避免连着两次挑到同一个。
 *
 * 候选只有一个时照样返回它 —— 那种情况用户就是想固定播这一个，不该因为「和上次一样」而不动。
 */
export function pickAction(candidates: readonly ActionItem[], avoid?: string, random: () => number = Math.random): ActionItem | undefined {
  if (!candidates.length) return undefined;
  const pool = candidates.length > 1 && avoid ? candidates.filter(item => item.key !== avoid) : candidates;
  const usable = pool.length ? pool : candidates;
  return usable[Math.min(usable.length - 1, Math.floor(random() * usable.length))];
}

/**
 * 快捷键是否可以注册。
 *
 * 拒绝不带修饰键的单键：给「挥手」配了 `X` 之后，用户在**任何**程序里打字打到 x 都会挥手 ——
 * 全局快捷键是系统级的，不看焦点在谁那里。这不是保守，是这个功能唯一的伤人方式。
 */
export function isUsableShortcut(accelerator: string): boolean {
  const parts = accelerator.split("+").map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const modifiers = new Set(["Control", "Ctrl", "Alt", "Option", "Shift", "Super", "Meta", "Command", "CommandOrControl"]);
  const keys = parts.filter(part => !modifiers.has(part));
  return keys.length === 1 && parts.some(part => modifiers.has(part));
}

/**
 * 把一次 keydown 变成 Tauri 的 accelerator 写法。修饰键还没按下实际键时返回 undefined
 * （录制中用户先按住 Ctrl 是正常的，那一刻不该判定成录好了）。
 */
export function acceleratorFromEvent(event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "key" | "code">): string | undefined {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  const key = normalizeKey(event);
  if (!key) return undefined;
  return [...parts, key].join("+");
}

/** 修饰键本身不算「实际按键」；字母统一大写，数字与功能键原样。 */
function normalizeKey(event: Pick<KeyboardEvent, "key" | "code">): string | undefined {
  if (["Control", "Alt", "Shift", "Meta", "OS"].includes(event.key)) return undefined;
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) return event.key;
  const named: Record<string, string> = {
    " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Escape: "Escape", Enter: "Enter", Tab: "Tab", Backspace: "Backspace",
  };
  if (named[event.key]) return named[event.key];
  return event.key.length === 1 ? event.key.toUpperCase() : undefined;
}

/**
 * 从旧的四个名单迁移出触发绑定。
 *
 * 1.0 把这件事存成四个复选框名单：`expressionPool`（单击的表情）、`motionPool`（双击的动作），
 * 外加两个闲置名单。合成一张表之后，前两个变成了「触发」这一列的两个取值。
 *
 * 只在还没有 `triggers:<dir>` 时跑一次；跑完就以新键为准，旧键留着不动 ——
 * 万一用户降级回 1.0，他的名单还在。
 */
export function migrateTriggers(
  items: readonly ActionItem[],
  clickExpressions: readonly string[],
  dblclickMotions: readonly string[],
): Record<string, Trigger> {
  const out: Record<string, Trigger> = {};
  const usable = (key: string) => items.some(item => item.key === key && !item.hold);
  for (const name of clickExpressions) {
    const key = expressionActionKey(name);
    if (usable(key)) out[key] = CLICK;
  }
  for (const motion of dblclickMotions) {
    const key = `motion:${motion}`;
    if (usable(key)) out[key] = DBLCLICK;
  }
  return out;
}

/**
 * 没有任何历史设置时给的默认触发。
 *
 * **开关一律留空。** 它们是外观状态（猫耳、上身、手里的杯子），不是「你戳我一下」的回应；
 * 放进随机池的后果是点一下人物脑袋就没了 —— 1.0 的默认名单确实是这么干的，
 * 因为那时候还分不出开关和表情。所以迁移那条路也一并把开关滤掉。
 *
 * 剩下的按老规矩：真正的表情（多参数的那种）归单击，动作归双击。这样开箱点一下有反应，
 * 又不会随机改变人物的外观。
 */
export function defaultTriggers(items: readonly ActionItem[]): Record<string, Trigger> {
  const out: Record<string, Trigger> = {};
  for (const item of items) {
    if (item.hold) continue;
    out[item.key] = item.kind === "motion" ? DBLCLICK : CLICK;
  }
  return out;
}

/**
 * 按作者的分类把行分块。组内保持原顺序；没分类的项归到最后一组（组名为 `undefined`，
 * 界面显示成「其他」）—— **不凭空造分类**，CandyBoy 就是 34 项全在一个组里，那就是一整块。
 *
 * 动作（真 motion）永远单独一组：它们不是开关，常驻那一列对它们没有意义。
 */
export function groupActions(items: readonly ActionItem[]): { group?: string; items: ActionItem[] }[] {
  const order: (string | undefined)[] = [];
  const byGroup = new Map<string | undefined, ActionItem[]>();
  for (const item of items) {
    const group = item.kind === "motion" ? MOTION_GROUP : item.group;
    if (!byGroup.has(group)) { byGroup.set(group, []); order.push(group); }
    byGroup.get(group)!.push(item);
  }
  return order.map(group => ({ group, items: byGroup.get(group)! }));
}

/** 动作那一组的组名。是个哨兵值，界面把它翻译成「动作」。 */
export const MOTION_GROUP = " motion";

/**
 * 常驻的项要按住的参数。同一个参数被勾了多次也只按一次。
 *
 * 不做任何冲突检测：这些参数彼此独立，同时置 1 就同时画出来
 * （实测 酒 + 麦克风 + 生气 + 星星 + 爱心 + 兽耳 六样同时生效，谁也没顶掉谁）。
 * 道具叠在同一只手上确实难看，但那是显示体验，不是逻辑冲突 ——
 * 而「哪两项占用同一个身体部位」模型里没有任何数据记录，猜只会猜错。由用户自己决定勾什么。
 */
export function heldParameters(items: readonly ActionItem[], held: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    if (item.hold && held.includes(item.key)) out[item.hold] = 1;
  }
  return out;
}
