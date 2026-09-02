import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { motionGroupLabel, motionKey, motionLabel, motionRefs, type ModelInventory } from "./inventory";
import type { AudioSource } from "./audio-source";
import type { StateSource } from "./prefs";
import type { Language } from "./prefs";

/**
 * 系统原生右键菜单。
 *
 * 为什么不再用画在网页里的 HTML 菜单：主窗口只有 340×440 且透明无边框，HTML 菜单被窗口边界
 * 裁切、窗口一小就挤成一团；更要命的是**窗口外的点击根本到不了网页**，点桌面关不掉菜单。
 * 原生菜单由系统绘制，能超出窗口、点任何地方自动收起 —— 这正是普通软件的表现。
 *
 * 代价是原生菜单只有文本项/勾选项/子菜单三种（[官方 API](https://v2.tauri.app/learn/window-menu/)），
 * **没有滑块、也做不了「一行两个动作」**。那些（缩放、透明度、随机名单）搬进了设置窗口。
 */
/** 菜单里的一个模型条目。`source` 决定它从哪个前缀加载。 */
export interface ModelChoice {
  dir: string;
  label: string;
  source: "bundled" | "installed";
  /** 用户装的模型才有：没有 avatar.json 时需要它来合成清单。 */
  model3?: string;
  adapted?: boolean;
}

export interface NativeMenuState {
  models: ModelChoice[];
  currentDir: string;
  inventory: ModelInventory;
  audioSource: AudioSource;
  stateSource: StateSource;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  focus: boolean;
  snapBottom: boolean;
  eyeTracking: boolean;
  language: Language;
}

export interface NativeMenuHandlers {
  onModel(choice: ModelChoice): void;
  onMotion(group: string, index: number): void;
  onExpression(name: string): void;
  onAudioSource(source: AudioSource): void;
  onStateSource(source: StateSource): void;
  onAlwaysOnTop(on: boolean): void;
  onClickThrough(on: boolean): void;
  onFocus(on: boolean): void;
  onSnapBottom(on: boolean): void;
  onEyeTracking(on: boolean): void;
  onResetPosition(): void;
  onGallery(): void;
  onOpenModelsDir(): void;
  onSettings(): void;
  onQuit(): void;
}

const text = (language: Language, zh: string, en: string): string => language === "en" ? en : zh;
const audioLabels = (language: Language): [AudioSource, string][] => [["off", text(language, "无", "None")], ["global", text(language, "系统全局", "System Global")], ["file", text(language, "音频文件…", "Audio File…")], ["hermes", "Hermes"]];
// 「状态来源」= 读哪个 harness 的语义状态（表情跟谁走）。与「声音来源」是两件事。
const stateLabels = (language: Language): [StateSource, string][] => [
  ["off", text(language, "无", "None")], ["auto", text(language, "自动（最近活动的）", "Auto (most recently active)")],
  ["claude-code", "Claude Code"], ["codex", "Codex"], ["dsh", "DeepSeek Harness"],
  ["hermes", "Hermes"], ["workbuddy", "WorkBuddy"]];

const check = (text: string, checked: boolean, action: () => void) => CheckMenuItem.new({ text, checked, action });
const separator = () => PredefinedMenuItem.new({ item: "Separator" });

/**
 * 模型子菜单：随包模型 + 用户装的模型 + 画廊/打开文件夹。
 *
 * **当前模型点了不做任何事**：切换要重载页面，而 macOS 会在点击瞬间就把勾选框翻转 ——
 * 重复点当前项除了白重载一次，还会让「勾选」看起来像可以多选。
 */
async function modelSubmenu(state: NativeMenuState, handlers: NativeMenuHandlers, log: MenuLog): Promise<Submenu> {
  const entries = await Promise.all(state.models.map(entry => {
    const current = entry.dir === state.currentDir;
    return check(entry.label, current, current
      ? () => log({ event: "menu:model:already-current", dir: entry.dir })
      : traced(log, `model:${entry.dir}`, () => handlers.onModel(entry)));
  }));
  const items: (Submenu | MenuItem | CheckMenuItem | PredefinedMenuItem)[] = entries.length
    ? entries
    : [await MenuItem.new({ text: text(state.language, "（没有可用模型，把模型文件夹拖进设置窗口即可安装）", "No models available — drop a model folder into Settings to install"), enabled: false })];
  return Submenu.new({
    text: text(state.language, "模型", "Models"),
    items: [
      ...items,
      await separator(),
      // 放在这里而不是顶层：它们都是「管理模型」的动作，跟切换模型是一回事的两面。
      await MenuItem.new({ text: text(state.language, "模型画廊…", "Model Gallery…"), action: traced(log, "gallery", () => handlers.onGallery()) }),
      await MenuItem.new({ text: text(state.language, "打开模型文件夹", "Open Models Folder"), action: traced(log, "open-models-dir", () => handlers.onOpenModelsDir()) }),
    ],
  });
}

/** 动作按组分成二级子菜单：Hiyori 有 7 个组，全平铺会拉出一条很长的菜单。 */
async function motionSubmenu(state: NativeMenuState, handlers: NativeMenuHandlers, log: MenuLog): Promise<Submenu> {
  const groups = new Map<string, number[]>();
  for (const [group, index] of motionRefs(state.inventory)) {
    groups.set(group, [...(groups.get(group) ?? []), index]);
  }
  const items = await Promise.all([...groups].map(([group, indices]) =>
    Submenu.new({
      text: motionGroupLabel(group, state.language === "en"),
      items: indices.map(index => ({
        text: motionLabel(state.inventory, [group, index]),
        action: traced(log, `motion:${group}:${index}`, () => handlers.onMotion(group, index)),
      })),
    })));
  return Submenu.new({
    text: text(state.language, "动作", "Motions"),
    items: items.length ? items : [await MenuItem.new({ text: text(state.language, "（这个模型没有动作）", "This model has no motions"), enabled: false })],
  });
}

async function expressionSubmenu(state: NativeMenuState, handlers: NativeMenuHandlers, log: MenuLog): Promise<Submenu> {
  const names = state.inventory.expressions;
  return Submenu.new({
    text: text(state.language, "表情", "Expressions"),
    items: names.length
      ? names.map(name => ({ text: name, action: traced(log, `expression:${name}`, () => handlers.onExpression(name)) }))
      : [await MenuItem.new({ text: text(state.language, "（这个模型没有表情）", "This model has no expressions"), enabled: false })],
  });
}

/**
 * 每个菜单项的动作都过一层日志。
 *
 * 原生菜单点不动时，症状（「点了没反应」）分不出是**回调没触发**还是**触发了但动作没生效**。
 * 有这条日志就能一眼分辨，省掉一轮来回。
 */
function traced(log: MenuLog, item: string, run: () => void): () => void {
  return () => { log({ event: "menu:click", item }); run(); };
}

export type MenuLog = (event: object) => void;

export async function buildNativeMenu(state: NativeMenuState, handlers: NativeMenuHandlers, log: MenuLog = () => {}): Promise<Menu> {
  const [models, expressions, motions] = await Promise.all([
    modelSubmenu(state, handlers, log),
    expressionSubmenu(state, handlers, log),
    motionSubmenu(state, handlers, log),
  ]);
  const items = await Promise.all([
    // 表情与动作排最前：它们是真正会反复点的两项，模型与声音来源属于「设定好就不太动」的。
    Promise.resolve(expressions),
    Promise.resolve(motions),
    separator(),
    Promise.resolve(models),
    Submenu.new({
      text: text(state.language, "声音来源", "Audio Source"),
      items: await Promise.all(audioLabels(state.language).map(([source, label]) =>
        check(label, state.audioSource === source, traced(log, `audio:${source}`, () => handlers.onAudioSource(source))))),
    }),
    Submenu.new({
      text: text(state.language, "状态来源", "Agent State Source"),
      items: await Promise.all(stateLabels(state.language).map(([source, label]) =>
        check(label, state.stateSource === source, traced(log, `state-source:${source}`, () => handlers.onStateSource(source))))),
    }),
    separator(),
    check(text(state.language, "窗口置顶", "Always on Top"), state.alwaysOnTop, traced(log, "always-on-top", () => handlers.onAlwaysOnTop(!state.alwaysOnTop))),
    check(text(state.language, "吸附底边", "Snap to Bottom"), state.snapBottom, traced(log, "snap-bottom", () => handlers.onSnapBottom(!state.snapBottom))),
    check(text(state.language, "聚焦模式", "Focus Mode"), state.focus, traced(log, "focus", () => handlers.onFocus(!state.focus))),
    check(text(state.language, "眼睛跟随鼠标", "Eyes Follow Cursor"), state.eyeTracking, traced(log, "eye-tracking", () => handlers.onEyeTracking(!state.eyeTracking))),
    check(text(state.language, "点击穿透", "Click Through"), state.clickThrough, traced(log, "click-through", () => handlers.onClickThrough(!state.clickThrough))),
    separator(),
    MenuItem.new({ text: text(state.language, "回到屏幕中央", "Center on Screen"), action: traced(log, "reset-position", () => handlers.onResetPosition()) }),
    MenuItem.new({ text: text(state.language, "设置…", "Settings…"), action: traced(log, "settings", () => handlers.onSettings()) }),
    separator(),
    MenuItem.new({ text: text(state.language, "退出 Agent Avatar", "Quit Agent Avatar"), action: traced(log, "quit", () => handlers.onQuit()) }),
  ]);
  return Menu.new({ items });
}

/**
 * 最小菜单：模型还在加载、或者压根加载失败时用。
 *
 * 完整菜单要等模型和清单都就绪（实机约 3 秒），这期间右键不能是「什么都没有」；
 * 更要紧的是**模型坏掉时它是唯一的退路** —— 无边框窗口没有标题栏，
 * 没有菜单就既关不掉也进不了设置，只能强杀进程。
 */
export async function buildFallbackMenu(
  handlers: Pick<NativeMenuHandlers, "onSettings" | "onResetPosition" | "onQuit">
    & Partial<Pick<NativeMenuHandlers, "onModel" | "onGallery" | "onOpenModelsDir">>,
  log: MenuLog = () => {},
  status: "loading" | "failed" = "loading",
  /** 加载失败时可切换的模型清单。给了就带上模型子菜单 —— 换一个模型是这时唯一的自救办法。 */
  models: ModelChoice[] = [],
  language: Language = "zh-CN",
): Promise<Menu> {
  // 失败时把模型子菜单也带上：卡片上写着「可以在右键菜单里换一个」，
  // 而这个菜单原来根本没有模型项 —— 用户照着文案做会发现做不到（实机撞到）。
  const rescue = status === "failed" && handlers.onModel
    ? [await modelSubmenu({ models, currentDir: "", language } as NativeMenuState,
        handlers as NativeMenuHandlers, log), await separator()]
    : [];
  const items = await Promise.all([
    // 头一项先说清楚「现在是什么处境」——否则用户只看到一个比平时短得多的菜单，
    // 不知道是加载没完还是菜单坏了。
    MenuItem.new({ text: status === "loading" ? text(language, "模型加载中…", "Loading model…") : text(language, "模型加载失败", "Model failed to load"), enabled: false }),
    separator(),
    ...rescue,
    MenuItem.new({ text: text(language, "设置…", "Settings…"), action: traced(log, "fallback:settings", () => handlers.onSettings()) }),
    MenuItem.new({ text: text(language, "回到屏幕中央", "Center on Screen"), action: traced(log, "fallback:reset-position", () => handlers.onResetPosition()) }),
    separator(),
    MenuItem.new({ text: text(language, "退出 Agent Avatar", "Quit Agent Avatar"), action: traced(log, "fallback:quit", () => handlers.onQuit()) }),
  ]);
  return Menu.new({ items });
}
