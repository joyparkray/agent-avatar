import { invoke } from "@tauri-apps/api/core";
import type { MotionRef } from "./inventory";
import { SEMANTIC_STATES, type SemanticState } from "./types";
import { cleanStateLabels } from "./state-labels";

/**
 * 主窗口与设置窗口共用的偏好读写。
 *
 * **存在 `config.json` 而不是 localStorage**（`~/Library/Application Support/<bundle-id>/`）。
 * 原因不是"卸载重装能保留"——那两者都做得到——而是 **localStorage 按 origin 分区**：
 * release 版的 origin 是 `http://127.0.0.1:<端口>`，而内嵌服务器在 17880 被占用时会依次漂到
 * 17881…17899。端口一漂 origin 就变了，用户的全部设置**凭空消失**（其实躺在另一个哈希目录里），
 * 而这是他既无法理解也无法自救的故障。config.json 是文件路径，与端口无关。
 * 附带好处：用户可以手编，也有地方放随包默认值。
 *
 * 读写策略：**启动时读一次进内存，之后同步读、异步落盘**。这样各处 API 保持同步，
 * 调用点不必全改成 async；落盘做了合并，连续拖滑块不会砸出几十次写。
 *
 * 需要**立即生效**的改动另发一条 Tauri 事件（见 `SETTINGS_EVENT`），config.json 只负责持久化。
 */
export const SETTINGS_EVENT = "settings:changed";
/**
 * 主窗口 → 设置页：哪些全局快捷键**没注册上**（被别的程序占了）。
 *
 * 方向和 SETTINGS_EVENT 相反。注册只能由主窗口做（设置页不常开），但报错必须显示在设置页
 * 那一行上 —— 静默失效的表现是「设了没反应」，用户无从判断是自己设错了还是程序坏了。
 */
export const SHORTCUT_STATUS_EVENT = "shortcuts:status";

/** 设置窗口改了什么。主窗口据此就地生效，不用重启。 */
export interface SettingsChange {
  modelDeleted?: string;
  hiddenModels?: string[];
  scalePercent?: number;
  opacityPercent?: number;
  lipSensitivityPercent?: number;
  mouthAmplitudePercent?: number;
  focusPercent?: number;
  statusPosition?: StatusPosition;
  idleDelaySeconds?: number;
  idleMotions?: string[];
  idleExpressions?: string[];
  /** 键 → 触发方式（`click` / `dblclick` / 快捷键）。见 actions.ts。 */
  triggers?: Record<string, string>;
  /** 状态栏第二行的开关。 */
  activityDetail?: boolean;
  /** 语义状态 → 用户起的显示名。空表示恢复内置文案。 */
  stateLabels?: Partial<Record<SemanticState, string>>;
  /** 语义状态 → 表情名。用户没配的状态回落到模型清单里作者写的那个。 */
  stateExpressions?: Partial<Record<SemanticState, string>>;
  /** 键 → 用户改的显示名。只影响显示，不影响播放。 */
  aliases?: Record<string, string>;
  /** 闲置自治的候选（合并后的键）。 */
  idleActions?: string[];
  /** 常驻的项：这些开关一直保持。 */
  heldActions?: string[];
  /** 设置页正在录制快捷键，主窗口要暂时让出已注册的全局热键。 */
  shortcutsSuspended?: boolean;
  quality?: string;
  fps?: number;
  enabledMotions?: string[];
  enabledExpressions?: string[];
  stateMotions?: Partial<Record<SemanticState, MotionRef>>;
  language?: Language;
}


type Store = Record<string, unknown>;

/** 标记「已经从 localStorage 搬过一次」。用它而不是"配置为空"来判断，理由见 loadPrefs。 */
const MIGRATED_FLAG = "migratedFromLocalStorage";
let store: Store = {};
let saveTimer: number | undefined;

/**
 * 启动时调用一次。读不到就当空的，各项退回默认值。
 *
 * 首次运行会把 localStorage 里的旧设置搬过来 —— 老用户不该因为换了存储方式就丢掉全部配置。
 */
export async function loadPrefs(): Promise<{ keys: number; migrated: number }> {
  store = await invoke<Store>("read_config").catch(() => ({})) ?? {};
  // 迁移的判据是**有没有迁过**，不是"配置是不是空的"。
  // 原来用后者，结果第一次迁移的写入撞上防抖窗口被页面重载打断，而随后 lastGoodModel
  // 写成功了 —— config 一有任何键，迁移机会就永久丢失（实机撞到）。
  const migrated = store[MIGRATED_FLAG] === true ? 0 : migrateFromLocalStorage();
  return { keys: Object.keys(store).length, migrated };
}

/**
 * 一次性迁移：localStorage 的键都带 `echo.` 前缀，去掉前缀存进 config。
 *
 * **只补 config 里没有的键** —— 万一迁移中途被打断，下次还能接着补，而已经改过的新值不会被旧值盖掉。
 */
function migrateFromLocalStorage(): number {
  let moved = 0;
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const full = localStorage.key(index);
      if (!full?.startsWith("echo.")) continue;
      const raw = localStorage.getItem(full);
      if (raw === null) continue;
      // 值统统是字符串；能解析成 JSON 的（数组、数字）就还原成原生类型，config.json 才好手编
      let value: unknown = raw;
      try { const parsed = JSON.parse(raw); if (parsed !== null) value = parsed; } catch { /* 保持字符串 */ }
      const key = full.slice("echo.".length);
      if (key in store) continue;  // 新值优先，别被旧的盖回去
      store[key] = value;
      moved++;
    }
  } catch { /* 隐私模式下 localStorage 不可用，没什么可迁的 */ }
  store[MIGRATED_FLAG] = true;
  // 迁移是一次性的关键写入，**不走防抖** —— 原来它撞上 200ms 窗口被页面重载打断，
  // 而丢了就再也补不回来（判据一旦变成"配置非空"就永远跳过）。
  save(true);
  return moved;
}

/**
 * 合并落盘：连续改动（拖滑块）只写一次。
 *
 * `immediate` 返回的是**落盘完成的 promise** —— 写完就要重载页面的调用方必须 `await` 它。
 * 落盘走 IPC，只是「不等 200ms」还不够：页面在 invoke 飞行途中被拆掉，写照样丢。
 */
function save(immediate = false): Promise<void> {
  if (saveTimer !== undefined) { clearTimeout(saveTimer); saveTimer = undefined; }
  const flush = () => invoke("write_config", { config: store })
    .then(() => undefined)
    .catch(error => { console.error("config save failed", error); });
  if (immediate) return flush();
  saveTimer = (globalThis as { setTimeout: typeof setTimeout }).setTimeout(() => {
    saveTimer = undefined;
    void flush();
  }, 200) as unknown as number;
  return Promise.resolve();
}

function readRaw(key: string): unknown { return store[key]; }

function writeRaw(key: string, value: unknown, immediate = false): Promise<void> {
  store[key] = value;
  return save(immediate);
}

/** 数字项。兼容迁移过来的字符串值（老 localStorage 里一切都是字符串）。 */
export const prefs = {
  read(key: string, fallback: number): number {
    const raw = readRaw(key);
    const value = typeof raw === "string" ? Number(raw) : raw;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  },
  write(key: string, value: number | boolean) { writeRaw(key, Number(value)); },
};

/**
 * 「状态来源」：读哪个 harness 写的语义状态。
 *
 * `auto` = 谁在写听谁的（按文件 mtime 取最新）。同时开着多个 agent 时形象会跟着
 * 最近活动的那个走；想钉死在某一家就选具体的。`off` = 不读，常驻 idle。
 *
 * **与「声音来源」无关**：一个决定显示谁的状态，一个决定嘴型的音频从哪来。
 * Hermes 的音频 token 永远从 Hermes 那份状态文件读，不受本项影响。
 */
export const STATE_SOURCES = ["auto", "hermes", "claude-code", "codex", "workbuddy", "dsh", "off"] as const;
export type StateSource = typeof STATE_SOURCES[number];

/** 音源持久化：默认 `global`（系统音频）—— 它对所有 harness 都有效，
 *  而 `hermes` 只在装了 Hermes desktop 且走 speak-stream 时才有流（见 ROADMAP D1）。 */
export const AUDIO_SOURCES = ["off", "global", "file", "hermes"] as const;
export type PersistedAudioSource = typeof AUDIO_SOURCES[number];

function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = readRaw(key);
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? raw as T : fallback;
}

/**
 * 要不要**联网查一次版本号**。默认开。
 *
 * 🔴 关掉就是「不要联网」，没有例外 —— 有例外的话这个开关就成了摆设，而用户是认真的。
 * 查的只是一个版本字符串：不下载、不安装、不执行任何东西，发现有新版也只是告诉他一声。
 *
 * 默认开的理由：connector 随 app 一起发布，所以「有没有新 connector」这个问题现在等价于
 * 「有没有新 app」—— 用户不知道有新版本时，他连同 connector 一起停在旧版上。
 */
export function readUpdateCheck(): boolean {
  const raw = readRaw("updateCheck");
  return raw === undefined || raw === null ? true : Boolean(raw);
}
export function writeUpdateCheck(value: boolean): void { writeRaw("updateCheck", value); }

/**
 * 状态栏第二行：显示 agent 具体在做什么。**默认关**。
 *
 * 默认关是因为它显示的是 agent 在这台机器上具体动了什么 —— 文件名、域名、它给自己那一步
 * 写的说明。这些东西出现在一个常驻置顶的窗口上（会被录屏、被投屏、被同事看见），应当是
 * 用户主动打开的，不是他某天低头发现已经在那儿了。
 *
 * 这一份只管**界面显不显示**；真正决定「工具信息写不写进磁盘」的是 hook 那边读的开关文件，
 * 由 `set_activity_detail` 命令写。两处要一起改，否则会出现「界面关了但文件里还在写」。
 */
export function readActivityDetail(): boolean {
  return Boolean(readRaw("activityDetail"));
}
export function writeActivityDetail(value: boolean): void { writeRaw("activityDetail", value); }

/** 上次自动检查的时间戳。手动点「检查更新」不写它 —— 那不该影响自动检查的节奏。 */
export function readLastUpdateCheck(): number | null {
  const raw = readRaw("lastUpdateCheck");
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}
export function writeLastUpdateCheck(value: number): void { writeRaw("lastUpdateCheck", value); }

export function readStateSource(): StateSource { return readChoice("stateSource", STATE_SOURCES, "auto"); }
export function writeStateSource(value: StateSource): void { writeRaw("stateSource", value); }

/** `file` 不持久化：它指向一个一次性挑的文件，重启后那个选择没有意义，回落到 `global`。 */
/**
 * 默认**不采集**。
 *
 * 原来默认是 `global`，于是程序一启动就打开了系统音频回环 —— 用户还没要求口型同步，
 * 杀毒软件已经在报「这个程序在收集音频」了。那个提示本身没错，错的是我们没等用户开口。
 * 采集只在用户到设置里选了音源之后才开始。
 *
 * 已经存过选择的用户不受影响：存的值优先，这里改的只是没存过时用什么。
 */
export function readAudioSource(): PersistedAudioSource {
  const stored = readChoice("audioSource", AUDIO_SOURCES, "off");
  return stored === "file" ? "global" : stored;
}
export function writeAudioSource(value: PersistedAudioSource): void { writeRaw("audioSource", value); }

export function readHiddenModels(): string[] {
  const value = readRaw("hiddenModels");
  return Array.isArray(value) ? value.filter(item => typeof item === "string") as string[] : [];
}
export function writeHiddenModels(value: readonly string[]): void { writeRaw("hiddenModels", [...value]); }

export function currentModelDir(): string {
  const stored = readRaw("model");
  // 没配置过时的第一猜。模型外置后它多半不存在 —— 加载失败会走 recoverFromBadModel，
  // 由实际可用的清单接管，所以这里不需要（也不可能）猜对。
  return new URLSearchParams(location.search).get("model") ?? (typeof stored === "string" ? stored : "haru");
}

export const motionPoolKey = (dir: string): string => `motionPool:${dir}`;
export const expressionPoolKey = (dir: string): string => `expressionPool:${dir}`;

/**
 * 闲置自治有**自己的**名单，与点击/双击那份分开。
 *
 * 同一个动作在两种场合的合适程度并不一样：打哈欠适合闲着的时候自己做，
 * 却不适合作为「你点我一下」的回应；反过来招手适合回应，自己没事干时一直招手就很怪。
 */
export const idleMotionPoolKey = (dir: string): string => `idleMotionPool:${dir}`;
export const idleExpressionPoolKey = (dir: string): string => `idleExpressionPool:${dir}`;

export const triggerMapKey = (dir: string): string => `triggers:${dir}`;
export const aliasMapKey = (dir: string): string => `aliases:${dir}`;
/** 闲置名单。表情与动作合成一张表之后，这两份也合成一份。 */
export const idleActionPoolKey = (dir: string): string => `idleActions:${dir}`;
/** 常驻名单：这些项对应的参数每帧按住，可以同时开多个。 */
export const heldActionPoolKey = (dir: string): string => `heldActions:${dir}`;

/**
 * 存过没有 —— 迁移只该跑一次，而「存过一个空映射」和「从来没存过」必须分得开：
 * 用户把所有触发都清空之后，不能下次打开设置又被旧名单迁移回来。
 */
export function hasStored(key: string): boolean { return readRaw(key) !== undefined; }

/** 按模型存的「键 → 字符串」映射（触发绑定、别名）。存坏了就当没存过。 */
export function readStringMap(key: string): Record<string, string> {
  const raw = readRaw(key);
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
}

/** 写映射；空值的项直接不存，免得配置里堆一堆 `""`。 */
export function writeStringMap(key: string, value: Record<string, string>): void {
  writeRaw(key, Object.fromEntries(Object.entries(value).filter(([, item]) => item)));
}

/** 读随机名单；没存过或存坏了都返回 null，由调用方决定默认值。 */
export function readPool(key: string): string[] | null {
  const raw = readRaw(key);
  const list = typeof raw === "string" ? safeParse(raw) : raw;
  return Array.isArray(list) && list.every(item => typeof item === "string") ? list as string[] : null;
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

export function writePool(key: string, list: readonly string[]): void { writeRaw(key, [...list]); }

export const LANGUAGES = ["zh-CN", "en"] as const;
export type Language = typeof LANGUAGES[number];
export function language(): Language { return readChoice("language", LANGUAGES, "zh-CN"); }

/** Cubism 5.1 离屏合成画不出来时的说法。不止是脸不对：还会出现各种颜色的方块，别把话说窄。
 *  主窗口与画廊共用一处措辞，改一次两边都变。 */
export const UNSUPPORTED_CUBISM_TEXT: Record<Language, string> = {
  "zh-CN": "该模型使用 Cubism 5.1，当前渲染器不支持",
  en: "This model uses Cubism 5.1, which the current renderer does not support",
};
export function rememberLanguage(value: Language): void { writeRaw("language", value); }

/**
 * 首次运行的「Agent 接入向导」是否已经出现过。
 *
 * 只记「出现过」，不记「装成功了」—— 用户可能就是不想现在接（或者用的 agent 不在五家里），
 * 每次开机都糊一张卡片在脸上是骚扰。想再进来走设置 → Agent → 接入，那里是同一份界面。
 */
export function connectorWizardSeen(): boolean { return readRaw("connectorWizardSeen") === true; }
export function rememberConnectorWizardSeen(): void { writeRaw("connectorWizardSeen", true); }

export const stateMotionMapKey = (dir: string): string => `stateMotions:${dir}`;
export const stateExpressionMapKey = (dir: string): string => `stateExpressions:${dir}`;
/** 状态显示名是**跟着 agent 走**的，不是跟着模型走 —— 换个皮肤不该把「生气中」改回「出错」。 */
export const STATE_LABEL_KEY = "stateLabels";

/** 只接受已知状态和 [group, non-negative integer]；模型库存校验由设置页负责。 */
export function readStateMotions(dir: string): Partial<Record<SemanticState, MotionRef>> {
  const raw = readRaw(stateMotionMapKey(dir));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([state, motion]) =>
    (SEMANTIC_STATES as readonly string[]).includes(state) && Array.isArray(motion) && motion.length === 2
    && typeof motion[0] === "string" && motion[0].length > 0 && Number.isSafeInteger(motion[1]) && motion[1] >= 0,
  )) as Partial<Record<SemanticState, MotionRef>>;
}

export function rememberStateMotions(dir: string, value: Partial<Record<SemanticState, MotionRef>>): void {
  writeRaw(stateMotionMapKey(dir), value);
}

/**
 * 语义状态 → 表情。
 *
 * 🔴 **原来这一半是配不了的。** 界面只让选动作，而 `playSemantic` 除了播动作还会设一个表情
 * —— 那个表情只能来自模型自带的 `avatar.json`。于是「思考时换个表情」这种最直觉的需求，
 * 用户明明看得见表情列表，却无处可设。
 *
 * 存的是表情名（Cubism 的 expression id），不是动作那种 `[组, 序号]`：表情本来就按名字寻址。
 * 空字符串当作没配 —— 否则用户清空选择之后会被存成一个查不到的表情，表现是「设了没反应」。
 */
export function readStateExpressions(dir: string): Partial<Record<SemanticState, string>> {
  const raw = readRaw(stateExpressionMapKey(dir));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([state, name]) =>
    (SEMANTIC_STATES as readonly string[]).includes(state) && typeof name === "string" && name.length > 0,
  )) as Partial<Record<SemanticState, string>>;
}

export function rememberStateExpressions(dir: string, value: Partial<Record<SemanticState, string>>): void {
  writeRaw(stateExpressionMapKey(dir), value);
}

/** 用户给状态起的显示名。清洗在 state-labels 里，这里只管存取。 */
export function readStateLabels(): Partial<Record<SemanticState, string>> {
  return cleanStateLabels(readRaw(STATE_LABEL_KEY));
}

export function rememberStateLabels(value: Partial<Record<SemanticState, string>>): void {
  writeRaw(STATE_LABEL_KEY, cleanStateLabels(value));
}

/** 模型来源：随包的走内嵌资源，用户装的走数据目录（`.app` 只读，装不进去）。 */
export type ModelSource = "bundled" | "installed";

export function currentModelSource(): ModelSource {
  return readRaw("modelSource") === "installed" ? "installed" : "bundled";
}

/**
 * 切模型。**返回的 promise 必须 await 完再重载页面** —— 每个调用方都紧接着重载。
 *
 * 走防抖的话这两个键会连页面一起消失：实机撞到过 —— 菜单里选了模型、页面重载后
 * `modelSource` 还是旧的 `bundled`，而 `model` 从 URL 参数拿到了新值，
 * 于是拿新目录去旧来源里找，报「invalid avatar manifest」，看起来像模型坏了。
 * 与 `migrateFromLocalStorage` 同一条教训：一次性的关键写入不该走防抖。
 */
export function rememberModel(dir: string, source: ModelSource): Promise<void> {
  store["model"] = dir;
  return writeRaw("modelSource", source, true);
}

/** 两种来源由内嵌 HTTP 服务器的不同前缀提供（见 static_server 的 USER_MODELS_PREFIX）。 */
export function modelBaseUrl(dir: string, source: ModelSource): string {
  return source === "installed" ? `/user-models/${dir}` : `/models/${dir}`;
}

const LAST_GOOD_KEY = "lastGoodModel";

/** 记下「确实加载成功过」的模型，供加载失败时回退。 */
export function rememberGoodModel(dir: string, source: ModelSource): void {
  writeRaw(LAST_GOOD_KEY, { dir, source });
}

export function lastGoodModel(): { dir: string; source: ModelSource } | null {
  const raw = readRaw(LAST_GOOD_KEY);
  const value = (typeof raw === "string" ? safeParse(raw) : raw) as { dir?: unknown; source?: unknown } | null;
  if (typeof value?.dir !== "string" || !value.dir) return null;
  return { dir: value.dir, source: value.source === "installed" ? "installed" : "bundled" };
}

/**
 * 聚焦模式显示模型顶部的百分之多少。
 *
 * 内部用的是「放大倍数」（放大 3 倍 = 只见顶部 1/3），但那个数对用户没有意义 ——
 * 「显示顶部 33%」才是他看得懂的说法，于是 UI 用百分比，这里换算成倍数。
 * 模型的身长比例千差万别：全身模型裁到 33% 正好是头肩胸，而 2/3 身的模型（如 haru_ja）
 * 本来就只画到腰，再裁 33% 就只剩一个头了 —— 所以必须让用户自己调。
 */
export const DEFAULT_FOCUS_PERCENT = 33;

/** 用户有没有自己调过聚焦范围（没存过 = 没调过，交给自动判断）。 */
export function hasFocusPercent(): boolean {
  return readRaw("focusPercent") !== undefined;
}

export function focusPercent(): number {
  const value = prefs.read("focusPercent", DEFAULT_FOCUS_PERCENT);
  return Math.min(100, Math.max(20, value));
}

export function focusZoomFromPercent(percent: number): number {
  return 100 / Math.min(100, Math.max(20, percent));
}

/** 状态栏摆在哪。窗口是透明悬浮窗，人物位置随构图变化，固定一个角落未必合适。 */
export const STATUS_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right", "none"] as const;
export type StatusPosition = typeof STATUS_POSITIONS[number];
export const STATUS_LABELS: Record<StatusPosition, string> = {
  "top-left": "左上", "top-right": "右上", "bottom-left": "左下", "bottom-right": "右下", none: "不显示",
};

export function statusPosition(): StatusPosition {
  const value = readRaw("statusPosition");
  return (STATUS_POSITIONS as readonly string[]).includes(value as string) ? value as StatusPosition : "bottom-left";
}

export function rememberStatusPosition(value: StatusPosition): void {
  writeRaw("statusPosition", value);
}

/**
 * 静置多少秒后开始闲置自治。**0 = 关闭**。
 *
 * 秒数本身就兼任开关了 —— 再给一个独立开关会产生「开关开着但秒数是 0」这种自相矛盾的状态。
 */
export const DEFAULT_IDLE_DELAY_SECONDS = 8;

export function idleDelaySeconds(): number {
  const raw = readRaw("idleDelaySeconds");
  if (raw === undefined) return DEFAULT_IDLE_DELAY_SECONDS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.min(600, Math.round(value)) : DEFAULT_IDLE_DELAY_SECONDS;
}

export function rememberIdleDelay(seconds: number): void {
  writeRaw("idleDelaySeconds", Math.max(0, Math.min(600, Math.round(seconds))));
}

/** 画质档位。原先散在 main.ts / settings.ts 里各写一次 localStorage，一并收进来。 */
export function quality(): string | null {
  const value = readRaw("quality");
  return typeof value === "string" ? value : null;
}

export function rememberQuality(value: string): void { writeRaw("quality", value); }

/** 口型：灵敏度与张嘴幅度。两个都是**全局**设置 —— 与「缩放」「透明度」同一类，
 *  换模型不该重调。默认值即这两个设置出现之前的固定行为。 */
export const DEFAULT_LIP_SENSITIVITY = 50;
export const DEFAULT_MOUTH_AMPLITUDE = 100;
export const lipSensitivityPercent = (): number => prefs.read("lipSensitivity", DEFAULT_LIP_SENSITIVITY);
export const mouthAmplitudePercent = (): number => prefs.read("mouthAmplitude", DEFAULT_MOUTH_AMPLITUDE);
