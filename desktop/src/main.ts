import { actionLabel, actionsFor, CLICK, DBLCLICK, defaultTriggers, heldParameters, listActions, migrateTriggers, pickAction, shortcutsIn, type ActionItem, type SwitchTable, type Trigger } from "./actions";
import { register, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import "./style.css"; import "./state.css"; import { invoke } from "@tauri-apps/api/core"; import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadPrefs, language, quality, rememberLanguage, rememberQuality, focusPercent, focusZoomFromPercent, hasFocusPercent, idleDelaySeconds, idleActionPoolKey, heldActionPoolKey, aliasMapKey, hasStored, readStringMap, triggerMapKey, SHORTCUT_STATUS_EVENT, rememberIdleDelay, rememberStatusPosition, statusPosition, currentModelDir, currentModelSource, expressionPoolKey, lastGoodModel, modelBaseUrl, motionPoolKey, prefs, readHiddenModels, readPool, readStateMotions, readStateExpressions, readStateLabels, readActivityDetail, UNSUPPORTED_CUBISM_TEXT, rememberGoodModel, rememberModel, writePool, SETTINGS_EVENT, readAudioSource, writeAudioSource, lipSensitivityPercent, mouthAmplitudePercent, readStateSource, writeStateSource, connectorWizardSeen, rememberConnectorWizardSeen, type Language, type StateSource, type SettingsChange } from "./prefs";
import { stateLabel } from "./state-labels";
import type { ModelChoice } from "./native-menu";
import type { ModelSource } from "./prefs";
import type { AvatarSource } from "./types";
import { Live2DAvatarModel } from "./live2d";
import { FPS_CHOICES, RENDER_SCALE, type RenderQuality } from "./render-quality"; import { AvatarDirector } from "./director"; import { SemanticDriver } from "./semantic"; import { VoiceDriver, voiceWebSocketUrl } from "./voice";
import { installGlobalDiagnostics } from "./diagnostics";
import { installWindowDragging } from "./drag";
import { droppedPath } from "./drop";
import { errorMessage } from "./errors";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { buildFallbackMenu, buildNativeMenu, type NativeMenuHandlers } from "./native-menu";
import { IdleAutonomy } from "./idle";
import { CONNECTOR_TEXT, renderConnectors, type ConnectorState } from "./connectors";

/** 用户装的皮肤（Rust 侧扫数据目录得来）。 */
type InstalledModel = { dir: string; label: string; model3: string; adapted: boolean; displayNames?: Record<string, string>; switches?: SwitchTable };

/**
 * 菜单里的皮肤清单 = 随包的 + 用户装的。
 *
 * **每次打开菜单都重新扫一遍**：用户可能直接往皮肤文件夹里拖了新皮肤，没有经过安装流程。
 * 菜单本来就是每次重建的（勾选态要反映当前值），顺带 readdir 一次几乎没有开销 ——
 * 这样就不需要额外做一个「刷新」按钮。
 */
async function listModels(): Promise<ModelChoice[]> {
  const [bundled, installed] = await Promise.all([
    loadModelIndex().catch(() => []),
    invoke<InstalledModel[]>("list_installed_models").catch(() => [] as InstalledModel[]),
  ]);
  return [
    ...bundled.map(entry => ({ ...entry, source: "bundled" as const })),
    ...installed.map(item => ({ dir: item.dir, label: item.label, source: "installed" as const, model3: item.model3, adapted: item.adapted })),
  ];
}
const menuModels = (models: ModelChoice[], hidden = readHiddenModels()): ModelChoice[] =>
  models.filter(model => model.source !== "installed" || !hidden.includes(model.dir));

/** 当前皮肤从哪加载：随包走内嵌资源，用户装的走数据目录，且可能没有 avatar.json。 */
async function resolveAvatarSource(): Promise<AvatarSource> {
  const dir = currentModelDir();
  if (currentModelSource() === "installed") {
    const installed = await invoke<InstalledModel[]>("list_installed_models").catch(() => [] as InstalledModel[]);
    const found = installed.find(item => item.dir === dir);
    // 没有 avatar.json 时交出 model3 文件名，由 loadManifest 按官方信息合成清单
    if (found) return { baseUrl: modelBaseUrl(dir, "installed"), manifest: found.adapted ? "avatar.json" : undefined, model3: found.model3 };
  }
  return { baseUrl: modelBaseUrl(dir, "bundled"), manifest: "avatar.json" };
}
import { motionKey, motionRefs } from "./inventory";
import { bottomSnapY } from "./dock";
import { loadInventory, loadModelIndex, motionLabel } from "./inventory";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor } from "@tauri-apps/api/window";
import { AudioSourceController, lastRawLevel, setLipSensitivity, type AudioSource } from "./audio-source";
import type { AvatarState, SemanticState } from "./types";
function log(event: object): void { void invoke("log_event", { event: JSON.stringify(event) }).catch(() => {}); }
installGlobalDiagnostics(log);
const root = document.querySelector<HTMLDivElement>("#app")!; root.innerHTML = `<main class="shell idle"><div class="drag" data-tauri-drag-region></div><div class="model" data-tauri-drag-region></div><div class="status" data-no-drag>idle</div></main>`;
const shell = root.querySelector<HTMLElement>(".shell")!, status = root.querySelector<HTMLElement>(".status")!;
installWindowDragging(shell, getCurrentWindow(), log, async (dx, dy) => {
  // 补上阈值前被丢弃的位移，否则人物会一直落后光标 DRAG_THRESHOLD_PX。
  const window = getCurrentWindow(), scale = await window.scaleFactor();
  const origin = (await window.outerPosition()).toLogical(scale);
  await window.setPosition(new LogicalPosition(origin.x + dx, origin.y + dy));
});
// 点击穿透是**窗口级**开关：关掉期间网页层收不到任何事件，于是「点了没反应」在前端看来
// 和「根本没点」一模一样，无从分辨。这里把每一次真正到达网页的 pointerdown 记下来，
// 与 Rust 侧的 `hit:ignore-cursor` 翻转记录对时间，就能判断一次点击是撞上了 60ms 的
// 轮询窗口期（HIT_POLL_MS），还是被系统拿去激活窗口了 —— 见 WINDOWS-PORT.md WP6。
// 挂在捕获阶段：拖动、菜单等处理器都可能先行返回，挂在它们后面会漏记。
addEventListener("pointerdown", event => log({
  event: "input:pointerdown",
  button: event.button,
  x: Math.round(event.clientX), y: Math.round(event.clientY),
  target: (event.target as Element | null)?.className || null,
}), { capture: true });
// 启动自检：只探 Cubism Core —— 它是**唯一**随包的运行期资产（官方可再分发清单内）。
// 原来还探一张 `models/haru/...` 的贴图，皮肤外置之后那条路径在 .app 里必然 404，
// 探针只会稳定地报一个假故障。皮肤能不能取到由 model:loaded / model:failed 回答。
async function probeAssets(): Promise<void> {
  const script = await fetch("/vendor/live2d-core/live2dcubismcore.min.js")
    .then(response => ({ ok: response.ok, status: response.status, type: response.headers.get("content-type") }))
    .catch(error => ({ ok: false, error: String(error) }));
  log({ event: "assets:probe", script });
}

/**
 * 把口型电平转发给设置窗口的电平条。
 *
 * **只在设置页开着时才发**：电平每秒更新约 60 次，常驻广播是纯浪费的跨进程事件，
 * 而设置页大部分时间是关着的。设置页开/关时各发一条开关信号，这里据此起停。
 * 再降到 20Hz —— 一根柱子不需要 60fps，而 IPC 是有成本的。
 */
let meterWanted = false, meterLastSent = 0;
void listen("lip-meter:watch", event => { meterWanted = Boolean(event.payload); });
function forwardLipLevel(level: number): void {
  if (!meterWanted) return;
  const now = performance.now();
  if (now - meterLastSent < 50) return;
  meterLastSent = now;
  // 送**原始**音量给电平条（柱子画它），另带一个「嘴现在开着吗」给它上色。
  // 送包络的话，拉灵敏度会让柱子动而线不动 —— 与音频表的常规读法相反。
  void emit("lip-meter:level", { raw: lastRawLevel, open: level > 0 }).catch(() => {});
}
let currentState = "", clickThroughHint = false, manualActivityTimer: number | undefined;
let manual: { kind: "expression" | "motion"; name: string } | undefined;
let notice: "unsupported-cubism" | undefined, noticeTimer: number | undefined;
/**
 * 「模型文件夹」是同一个东西在设置页、右键菜单、这里的叫法，三处必须一致 ——
 * 原来这张卡叫它「安装目录」，用户照着提示去找一个别处根本不存在的名字。
 */
const ONBOARDING_TEXT = {
  "zh-CN": {
    title: "需要安装 Live2D 模型",
    description: "发布版本不内置模型。你可以用自己已有的模型，也可以下载一个免费模型。下载的包要先解压，再把",
    emphasis: "解压出来的模型文件夹",
    suffix: "直接拖到下面的方框里。名字带空格、表情没登记这类问题，导入时会自动处理好。",
    download: "下载免费模型",
    drop: "把模型文件夹拖到这里", installing: "正在安装…", installed: "装好了，正在加载…",
  },
  en: {
    title: "A Live2D model is required",
    description: "No model is bundled with this release. Use a model you already have, or download a free one. Extract the download first, then drag the ",
    emphasis: "extracted model folder",
    suffix: " onto the box below. Folder names with spaces, unregistered expressions and the like are fixed up on import.",
    download: "Download Free Model",
    drop: "Drop the model folder here", installing: "Installing…", installed: "Installed — loading…",
  },
} as const;

/**
 * 引导卡片的顶栏：拖动、最小化、关闭。
 *
 * 主窗口是**无边框透明窗**，平时靠人物身上的 `.drag` 条拖动。但两张引导卡要么把 `.shell`
 * 整个换掉（模型引导），要么盖住整窗（接入向导）—— 于是窗口既拖不动、也没有任何可见的
 * 关闭入口，卡在屏幕中央（右键菜单里其实有「退出」，但没人猜得到，实机被当成死机）。
 * 卡片自己把系统标题栏那三件事补上。
 */
const CARD_TEXT: Record<Language, { drag: string; minimize: string; quit: string; close: string }> = {
  "zh-CN": { drag: "按住这里可拖动窗口", minimize: "最小化", quit: "退出应用", close: "关闭" },
  en: { drag: "Drag here to move the window", minimize: "Minimize", quit: "Quit", close: "Close" },
};

function cardBar(locale: Language, dismiss: { label: string; run: () => void }, extra?: HTMLElement): HTMLElement {
  const copy = CARD_TEXT[locale];
  const bar = document.createElement("div");
  bar.className = "card-bar";
  // `data-tauri-drag-region`：交给系统拖窗口，不必自己算位移（人物身上那条阈值逻辑
  // 是为了不吞掉单击/双击，卡片上没有这个顾虑）。
  bar.setAttribute("data-tauri-drag-region", "");
  const grip = document.createElement("span");
  grip.className = "grip"; grip.textContent = "⠿"; grip.title = copy.drag;
  grip.setAttribute("data-tauri-drag-region", "");
  bar.append(grip);
  if (extra) bar.append(extra);
  const minimize = document.createElement("button");
  minimize.type = "button"; minimize.className = "card-button"; minimize.textContent = "–"; minimize.title = copy.minimize;
  minimize.addEventListener("click", () => void getCurrentWindow().minimize()
    .catch(error => log({ event: "card:minimize:error", error: String(error).slice(0, 200) })));
  const close = document.createElement("button");
  close.type = "button"; close.className = "card-button"; close.textContent = "\u2715"; close.title = dismiss.label;
  close.addEventListener("click", dismiss.run);
  bar.append(minimize, close);
  return bar;
}

/**
 * 首次运行的第二步：装完模型之后，把 agent 接上。
 *
 * 装模型引导只解决「看得见」，接上 connector 才解决「会动」—— 少了这一步，用户看到的是
 * 一个永远 idle 的形象，而他没有任何线索知道差的是什么（原来的做法是让他去 Release
 * 下 connectors.zip，在终端里跑脚本，这一步把绝大多数人挡在门外）。
 *
 * 只在**一家都没接**且没出现过时弹一次；之后的入口在设置 → Agent → 接入（同一份界面）。
 */
let wizardOpen = false;
async function maybeShowConnectorWizard(): Promise<void> {
  if (connectorWizardSeen()) return;
  const states = await invoke<ConnectorState[]>("list_connectors").catch(() => [] as ConnectorState[]);
  // 已经接上过的用户（老用户升级、或手动跑过脚本）不该被引导打扰
  if (states.some(state => state.installed)) { rememberConnectorWizardSeen(); return; }
  const locale = language(), copy = CONNECTOR_TEXT[locale];
  const card = document.createElement("div");
  card.className = "fallback onboarding connector-wizard";
  card.innerHTML = `<b></b><p></p><div class="connector-list" data-list="connectors"></div>`
    + `<div class="fallback-actions"><button data-act="close-wizard"></button></div>`;
  card.querySelector("b")!.textContent = copy.title;
  card.querySelector("p")!.textContent = copy.hint;
  const close = card.querySelector<HTMLButtonElement>('[data-act="close-wizard"]')!;
  close.textContent = copy.skip;
  // 这张卡同样盖住整窗，也同样比 340×440 高（五行 harness 加说明）。撑大之后要还回去 ——
  // 引导页那边靠重新加载时的 applyScale 收窗，这边不重载，得自己记住原来多大。
  const before = await getCurrentWindow().innerSize().catch(() => undefined);
  const scaleFactor = await getCurrentWindow().scaleFactor().catch(() => 1);
  const dismiss = () => {
    rememberConnectorWizardSeen();
    wizardOpen = false; card.remove();
    if (before) void getCurrentWindow().setSize(
      new LogicalSize(Math.round(before.width / scaleFactor), Math.round(before.height / scaleFactor)),
    ).catch(error => log({ event: "connector-wizard:restore:error", error: String(error).slice(0, 200) }));
    log({ event: "connector-wizard:closed" });
  };
  card.prepend(cardBar(locale, { label: CARD_TEXT[locale].close, run: dismiss }));
  renderConnectors(card.querySelector<HTMLElement>('[data-list="connectors"]')!, locale,
    () => { close.textContent = copy.done; });
  close.addEventListener("click", dismiss);
  root.append(card);
  wizardOpen = true;
  await fitWindowToCard(card).catch(error =>
    log({ event: "connector-wizard:fit:error", error: String(error).slice(0, 200) }));
  log({ event: "connector-wizard:shown" });
}

/** 模型加载失败时那张卡。与引导卡不同，它显示的是**已经出错**的处境，两种语言都要有。 */
const FAILURE_TEXT: Record<Language, { title: string; detail: string; pick: string; reload: string }> = {
  "zh-CN": {
    title: "模型加载失败",
    detail: "已退回上一个能用的模型仍然失败。换一个模型，或直接退出。",
    pick: "换一个模型…", reload: "重新加载",
  },
  en: {
    title: "The model failed to load",
    detail: "Falling back to the last working model did not help either. Pick another model, or quit.",
    pick: "Pick another model…", reload: "Reload",
  },
};

/** 错误原文会被拼进 innerHTML —— 模型名/路径里的 `<` 不能当成标签。 */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function applyOnboardingLanguage(locale: Language): void {
  const copy = ONBOARDING_TEXT[locale];
  root.querySelector<HTMLElement>('[data-onboarding="title"]')!.textContent = copy.title;
  root.querySelector<HTMLElement>('[data-onboarding="description"]')!.textContent = copy.description;
  root.querySelector<HTMLElement>('[data-onboarding="emphasis"]')!.textContent = copy.emphasis;
  root.querySelector<HTMLElement>('[data-onboarding="suffix"]')!.textContent = copy.suffix;
  root.querySelector<HTMLElement>('[data-act="download-model"]')!.textContent = copy.download;
  // 拖放区只在「还没开始安装」时才由语言切换重写，否则会把「正在安装…」覆盖掉
  const zone = root.querySelector<HTMLElement>('[data-act="drop-model"]');
  if (zone && zone.dataset.busy !== "1") zone.textContent = copy.drop;
  document.documentElement.lang = locale;
}
const REACTION_LABELS: Record<Language, Record<string, string>> = {
  "zh-CN": { blocked: "受阻", interrupted: "被打断" },
  en: { blocked: "Blocked", interrupted: "Interrupted" },
};
const CLICK_THROUGH_HINT: Record<Language, string> = {
  "zh-CN": "穿透中，悬停 3 秒可操作",
  en: "Click-through · hover 3s to interact",
};
const ACTIVITY_LABELS: Record<Language, { expression: string; motion: string }> = {
  "zh-CN": { expression: "表情", motion: "动作" },
  en: { expression: "Expression", motion: "Motion" },
};
/** 状态栏用的语言。设置窗口改了语言就地更新，故状态文字**渲染时**才拼，不在收到状态时定死。 */
let uiLanguage: Language = "zh-CN";
/** 用户给状态起的显示名。与 uiLanguage 同理：只存「哪一份」，拼字符串在 renderStatus 里。 */
let stateLabels: Partial<Record<SemanticState, string>> = {};
/** 「它具体在干嘛」的一行。空 = 不显示第二行。 */
let doing = "";
let detailEnabled = readActivityDetail();
let lastSnapshot: Readonly<AvatarState> | undefined;

function stateText(): string {
  if (!lastSnapshot) return "";
  const label = stateLabel(lastSnapshot.semantic, uiLanguage, stateLabels);
  const reaction = lastSnapshot.reaction ? REACTION_LABELS[uiLanguage][lastSnapshot.reaction] ?? lastSnapshot.reaction : "";
  return [label, reaction].filter(Boolean).join(" · ");
}
function renderStatus(): void {
  currentState = stateText();
  const warning = notice ? UNSUPPORTED_CUBISM_TEXT[uiLanguage] : "";
  const first = [currentState, manualActivity(), warning, clickThroughHint ? CLICK_THROUGH_HINT[uiLanguage] : ""].filter(Boolean).join(" · ");
  // 🔴 详情自己一行。挤在第一行里放不下：实测 description 中位 32 字符、90% 分位 45，
  // 而一行的预算约 46 个拉丁字符 —— 再叠上用户自定义的状态显示名（上限 24）就必然折行。
  // 用两个子节点而不是拼一个字符串：第二行要能单独设样式（更小、更淡），也要能整行省略。
  status.textContent = "";
  status.append(Object.assign(document.createElement("span"), { className: "status-line", textContent: first }));
  // 开着详情就**总是**建第二行，哪怕它是空的：空行占住位置，第一行才不会被顶上去。
  // 关着的时候连节点都不建 —— 那些用户拿到的应当是一模一样的老胶囊。
  if (detailEnabled) {
    status.dataset.detail = "";
    status.append(Object.assign(document.createElement("span"), { className: "status-doing", textContent: doing }));
  } else {
    delete status.dataset.detail;
  }
  // 标题只带状态：任务栏/程序坞上那一行更短，而详情每几秒就变一次，
  // 让窗口标题跟着抖等于让整个任务栏跟着抖。
  void getCurrentWindow().setTitle(`Agent Avatar${currentState ? ` · ${currentState}` : ""}`).catch(console.error);
}
/** 与手动触发同一行显示的一次性提示。同样只存「哪条」，语言在渲染时才解析。 */
function showUnsupportedNotice(durationMs = 20000): void {
  notice = "unsupported-cubism"; renderStatus();
  if (noticeTimer !== undefined) clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { notice = undefined; noticeTimer = undefined; renderStatus(); }, durationMs);
}

/** 手动触发的表情/动作也跟着语言走，故存的是「种类 + 名字」而不是拼好的字符串。 */
function manualActivity(): string {
  return manual ? `${ACTIVITY_LABELS[uiLanguage][manual.kind]} ${manual.name}` : "";
}
function showManualActivity(kind: "expression" | "motion", name: string, durationMs = 4000): void {
  manual = { kind, name }; renderStatus();
  if (manualActivityTimer !== undefined) clearTimeout(manualActivityTimer);
  manualActivityTimer = window.setTimeout(() => { manual = undefined; manualActivityTimer = undefined; renderStatus(); }, durationMs);
}
function show(snapshot: Readonly<AvatarState>) { lastSnapshot = snapshot; shell.className = `shell ${snapshot.semantic}`; shell.dataset.speaking = String(snapshot.speaking); shell.dataset.reaction = snapshot.reaction ?? ""; renderStatus(); const event = { event: "visual-state", ...snapshot, at: Date.now() }; console.info(JSON.stringify(event)); log(event); }
const BASE_SIZE = [340, 440] as const, HIT_REPORT_MS = 400;
/** 双击会先触发一次单击，故单击延后这么久执行，期间收到双击就取消。 */
const CLICK_EXPRESSION_DELAY_MS = 260;
/** 窗口停止移动多久后归位。拖动期间 onMoved 会连续触发，须等落定。 */
const DOCK_SETTLE_MS = 140;
async function applyScale(percent: number): Promise<void> {
  prefs.write("scale", percent);
  await getCurrentWindow().setSize(new LogicalSize(Math.round(BASE_SIZE[0] * percent / 100), Math.round(BASE_SIZE[1] * percent / 100)));
}

/** 整窗卡片放得开的最大尺寸（逻辑像素），再大就该考虑分页而不是继续长高。 */
const CARD_SIZE = [420, 760] as const;

const twoFrames = () => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/**
 * 把窗口撑到**这张卡片不需要滚动**。
 *
 * 🔴 桌宠窗口是 340×440 —— 那是给一个人物用的尺寸，不是给一屏说明文字用的。首启向导比它
 * 高，于是被裁掉一截：用户看到的是半个拖放框和一条滚动条，而「下载免费模型」那个按钮在窗外。
 * （给 `.fallback` 加 `overflow:auto` 只是让它**能滚**，不是让它**看得见**。）
 *
 * 尺寸量出来而不是写死：中英文案不一样长，连接器向导里还有五行 harness，写死的那个数
 * 总会对不上其中一种。量两帧 —— 一帧只够浏览器接到新宽度，文字重排在下一帧。
 *
 * 最多长三轮：每长高一次，卡片的 `max-height: calc(100% - 68px)` 也跟着放宽，于是可能
 * 露出新的一段。三轮之后还溢出就认了 —— 那是文案该短一点，不是窗口该更高。
 */
async function fitWindowToCard(card: HTMLElement, options: { center?: boolean } = {}): Promise<void> {
  const appWindow = getCurrentWindow();
  const width = Math.min(CARD_SIZE[0], Math.round(screen.availWidth * 0.9));
  const ceiling = Math.min(CARD_SIZE[1], Math.round(screen.availHeight * 0.9));
  let height: number = BASE_SIZE[1];
  await appWindow.setSize(new LogicalSize(width, height));
  for (let round = 0; round < 3; round += 1) {
    await twoFrames();
    const overflow = card.scrollHeight - card.clientHeight;
    if (overflow <= 1 || height >= ceiling) break;
    height = Math.min(height + overflow, ceiling);
    await appWindow.setSize(new LogicalSize(width, height));
  }
  // 变高之后窗口是往下长的，原来贴着屏幕下缘的话会长到屏幕外面去 —— 引导页没有人物要
  // 保持位置，居中最稳。连接器向导不居中：那时候人物在屏幕上，用户把它放哪是他的选择。
  if (options.center) await appWindow.center();
}


/**
 * 吸附底边：开启后窗口下缘对齐**显示器下缘**，移动后自动归位。
 * 不用工作区下缘 —— 那会排除 Dock 与菜单栏，在人物下方留出一条可见空隙。
 * 构图（全身/聚焦）是另一个独立开关，两者互不牵连。
 */
function installBottomSnap(enabled: () => boolean): { snap: () => Promise<void> } {
  const appWindow = getCurrentWindow();
  let settle: number | undefined;

  const snap = async (): Promise<void> => {
    if (!enabled()) return;
    try {
      const monitor = await currentMonitor();
      if (!monitor) return;
      const scale = await appWindow.scaleFactor();
      const origin = (await appWindow.outerPosition()).toLogical(scale);
      const screenTop = monitor.position.y / monitor.scaleFactor;
      const screenBottom = screenTop + monitor.size.height / monitor.scaleFactor;
      const workBottom = monitor.workArea.position.y / monitor.scaleFactor + monitor.workArea.size.height / monitor.scaleFactor;
      const target = bottomSnapY(screenTop, monitor.size.height / monitor.scaleFactor, innerHeight);
      if (Math.abs(target - origin.y) < 0.5) return;
      await appWindow.setPosition(new LogicalPosition(origin.x, target));
      // 同时记录工作区下缘，便于核对「空隙 = Dock 高度」这类问题。
      log({ event: "dock:snapped", from: Math.round(origin.y), to: Math.round(target),
            screenBottom: Math.round(screenBottom), workBottom: Math.round(workBottom), innerHeight });
    } catch (error) { log({ event: "dock:error", error: String(error).slice(0, 200) }); }
  };

  // 拖动期间 onMoved 连续触发，等落定再归位，否则会和系统拖拽打架。
  void appWindow.onMoved(() => {
    if (!enabled()) return;
    if (settle !== undefined) clearTimeout(settle);
    settle = window.setTimeout(() => { settle = undefined; void snap(); }, DOCK_SETTLE_MS);
  });
  return { snap };
}

/**
 * 右键的唯一入口，**在模块加载时就注册**。
 *
 * 之前它在 `installMenu` 末尾才注册，而 installMenu 开头要 await 加载 inventory、扫描皮肤目录。
 * 切换皮肤会重载页面，这段几十毫秒的窗口期里右键，漏出来的就是 WKWebView 的默认菜单
 * （Back / Reload / Inspect Element）—— 实机撞到过。
 * 现在无论菜单装配到哪一步，默认菜单都不会出现；菜单没就绪时右键只是没反应。
 */
let openContextMenu: ((event: MouseEvent) => void) | null = null;
/**
 * 通知闲置自治「现在有正事」。
 *
 * 自治在 installMenu 里才创建（要等 inventory 与随机名单就绪），而说话/语义的接线在那之前，
 * 所以留一个可替换的引用，装配好之前调用是空操作。
 */
let notifyIdleBusy: () => void = () => {};
document.addEventListener("contextmenu", event => {
  event.preventDefault();
  openContextMenu?.(event);
});

/** 任何时候都要有退路的那三项。皮肤没就绪、或加载失败时都用它。 */
const survivalHandlers = {
  onSettings: () => void invoke("open_tool_window", { name: "settings" }).catch(error => log({ event: "menu:settings:error", error: String(error).slice(0, 200) })),
  onResetPosition: () => void getCurrentWindow().center().catch(console.error),
  onQuit: () => void getCurrentWindow().close(),
};

/**
 * 皮肤加载失败后自动退回上一个能用的皮肤。
 *
 * 选中的皮肤记在配置里，坏皮肤会**每次启动都被重新加载** —— reload 也救不回来，
 * 用户就永远回不到能用的状态了（实机撞到过，最后只能强杀进程）。
 * 一次会话只自动回退一次，避免「回退目标也坏了」时无限重载。
 */
async function recoverFromBadModel(): Promise<boolean> {
  const RETRIED = "echo.modelRecoveryTried";
  if (sessionStorage.getItem(RETRIED)) return false;
  const current = { dir: currentModelDir(), source: currentModelSource() };
  // 回退目标必须是**实际存在**的皮肤，不能是硬编码的随包保底 —— 皮肤外置之后
  // 随包皮肤一个都没有，老用户配置里却还指着它（升级即开机卡在「加载失败」，
  // 而失败分支的右键菜单是精简版，换不了皮肤 = 自己救不了自己）。
  const available = menuModels(await listModels().catch(() => [] as ModelChoice[]));
  const exists = (choice: { dir: string; source: ModelSource }) =>
    available.some(item => item.dir === choice.dir && item.source === choice.source);
  const good = lastGoodModel();
  const target = [...(good ? [good] : []), ...available]
    .find(choice => exists(choice) && !(choice.dir === current.dir && choice.source === current.source));
  // 一个能用的都没有：交给 boot 的 catch 去显示「还没有形象」，别在这里空转重载
  if (!target) { log({ event: "model:recover:none", from: current.dir }); return false; }
  try { sessionStorage.setItem(RETRIED, "1"); } catch { /* 隐私模式：不重试也好过循环 */ }
  log({ event: "model:recover", from: current.dir, to: target.dir, via: good && exists(good) ? "last-good" : "first-installed" });
  // 必须等落盘 —— 下一行就把页面换掉了（见 prefs.rememberModel）
  await rememberModel(target.dir, target.source);
  // URL 参数会盖过配置里的值，必须一起换掉
  const url = new URL(location.href);
  url.searchParams.set("model", target.dir);
  location.replace(url.toString());
  return true;
}

async function boot() { log({ event: "boot:start" });
  // 配置必须在任何读取之前就位：它是同步 API + 内存缓存，只有这一次是异步的
  log({ event: "prefs:loaded", ...await loadPrefs() });
  uiLanguage = language();   // 模块级默认值只是占位，真正的值要等配置读完
  // 设置窗口在「还没有模型」时也能安装/选择模型，因此切换监听必须早于模型加载。
  void listen<SettingsChange>(SETTINGS_EVENT, ({ payload }) => {
    if (payload.modelDeleted === currentModelDir()) location.reload();
  }).catch(console.error);
  // 皮肤加载要几秒，这期间右键必须有东西可用；皮肤坏掉时它更是唯一的退路。
  openContextMenu = () => void buildFallbackMenu(survivalHandlers, log, "loading", [], language()).then(menu => menu.popup()).catch(console.error); void probeAssets(); try { const model = new Live2DAvatarModel(root.querySelector(".model")!, log); const avatarSource = await resolveAvatarSource(); await model.load(avatarSource); log({ event: "model:loaded", manifestId: model.manifestId });
    // 这个皮肤确实能加载 —— 记下来，将来某个坏皮肤把应用卡住时退回到它
    rememberGoodModel(currentModelDir(), currentModelSource());
    // 画不对就直说。静默地少画几个部件，用户只会以为是模型坏了或应用坏了（实机上正是如此：
    // ren 加载「成功」，脸上没有眉毛鼻子嘴）。
    if (model.offscreenCount > 0) {
      log({ event: "model:offscreen-unsupported", count: model.offscreenCount });
      showUnsupportedNotice();
    }
    // 成功加载后的 URL 参数才是最终真值。同步回 config，设置窗口没有主窗口的 query 参数，
    // 若不写回，嵌套模型会在设置页错误回落到旧的 `haru`，动作/表情 inventory 全空。
    await rememberModel(currentModelDir(), currentModelSource());
    try { sessionStorage.removeItem("echo.modelRecoveryTried"); } catch { /* 忽略 */ } const director = new AvatarDirector(model, snapshot => show(snapshot)); const applySpeaking = (speaking: boolean) => { director.setTalking(speaking); if (speaking) { model.lookAhead(); notifyIdleBusy(); } }; const voice = new VoiceDriver(log); voice.onVocalLevel(v => { model.setVocalLevel(v); forwardLipLevel(v); }); voice.onSpeaking(applySpeaking); const params = new URLSearchParams(location.search), override = params.get("endpoint"); const discovered = override ? { url: override, token: params.get("token") ?? "" } : await invoke<{ url: string; token?: string; auth_required?: boolean } | null>("discover_audio_endpoint"); // 只记 url 与「有没有 token」：token 是 Hermes 的会话凭据，日志默认落在 /tmp（全局可读），
// 整条 WS URL 里也带着它，写进去等于把 Hermes 的完整 API 访问权泄在磁盘上。
log({ event: "endpoint:discovered", url: discovered?.url ?? null, hasToken: Boolean(discovered?.token), authRequired: discovered?.auth_required ?? null }); const path = params.get("audioPath") ?? "/api/audio/observe"; if (discovered) log({ event: "voice:ready", path }); else log({ event: "endpoint:skipped" }); const audio = new AudioSourceController(voice, discovered ? { ...discovered, path } : null, command => invoke(command), v => { model.setVocalLevel(v); forwardLipLevel(v); }, applySpeaking, log); // 默认 `global`（系统音频）而不是 `hermes`：Hermes 的 /api/audio/observe 只在装了
    // Hermes desktop 且走 speak-stream 时才有流，对其他 harness 的用户默认根本不存在 ——
    // 那正是「打开就嘴一动不动」的原因（ROADMAP D1）。系统音频对所有会出声的 agent
    // 都有效（Codex Voice、Claude Desktop voice mode、本地 TTS 都从系统音频出）。
    // 用户选过就记住，不必每次开机重选。
    // 音源起不来**不能**掀翻整个 boot：这一段在 boot 的大 try 里，而它下面的 catch 会把任何
    // 异常报成「模型加载失败」并弹致命窗。Windows 上必现（全局采集只有 macOS 有，
    // `start_global_audio` 直接 Err），实机表现是：模型明明已经加载、Idle 动作都起来了，
    // 却被一个音频错误顶成「模型加载失败」，用户按提示去换模型，换几个都一样。
    // macOS 上同样够得着 —— 用户拒绝音频权限、或 process tap 建不起来时是同一条路径。
    //
    // 音源只驱动嘴型：拿不到就退回 off，形象、状态、动作全都照常。
    try {
      await audio.start(readAudioSource());
    } catch (error) {
      log({ event: "audio-source:unavailable", source: readAudioSource(), error: String(error).slice(0, 200) });
      await audio.start("off").catch(() => {});
    }
    // 语义轮询顺带盯着 token：desktop 每次启动重新生成 token（且换端口），由 hook 写进同一个
    // 状态文件。复用这条已有的轮询，不另起定时器。
    // 「状态来源」读哪个 harness 的语义状态。声明必须在轮询器之前 —— 它被闭包捕获，
    // 菜单改了之后下一拍轮询就生效，不用重建 driver。
    let stateSource = readStateSource();
    let currentToken = discovered?.token ?? "";
    // 状态文件找不到时只表现为「一直 idle」，没有任何提示：hook 没注册、或 hook 与本进程的
    // TMPDIR 不一致，看起来都像「接上了但 Echo 不变脸」。只在有无之间翻转时记一条，不刷屏。
    let stateFileSeen: boolean | undefined;
    new SemanticDriver(async () => {
      const snapshot = await invoke<{ state?: string; sequence?: number; token?: string; reaction?: { kind?: string; sequence?: number; at?: number } | null } | null>("read_semantic_state", { source: stateSource });
      if (stateFileSeen !== Boolean(snapshot)) { stateFileSeen = Boolean(snapshot); log({ event: "semantic:state-file", found: stateFileSeen }); }
      const token = snapshot?.token ?? "";
      if (token && token !== currentToken) {
        currentToken = token;
        // token 换了基本等于 desktop 重启过，端口（`--port 0`）也跟着变了，所以要重新发现而不是
        // 沿用开机那次的 url。discover 内部同样会读到这个新 token。
        const found = await invoke<{ url: string; token?: string } | null>("discover_audio_endpoint");
        if (found) await audio.retarget({ ...found, path });
      }
      return snapshot;
    }, s => { director.setSemantic(s); if (s !== "idle") notifyIdleBusy(); }, 200, 2000,
      reaction => director.setReaction(reaction),
      next => { doing = detailEnabled ? next : ""; renderStatus(); }).start(); log({ event: "semantic:started" });
    await installMenu(model, audio, avatarSource, source => { stateSource = source; });
    // 模型已经在动了，接下来才轮到「接上你的 agent」——
    // 两张卡片同时糊在脸上没人看得懂先做哪一件。
    void maybeShowConnectorWizard();
(window as any).echoSkin = { voice, director, model, audio }; } catch (error) {
    log({ event: "model:failed", error: String(error).slice(0, 300) });
    console.error(error);
    // 先尝试自动退回上一个能用的皮肤；成功的话页面会重载，下面的收尾不必再跑。
    if (await recoverFromBadModel()) return;
    // 回退也救不了：菜单换成「加载失败」版，但**带上皮肤清单** ——
    // 这时换一个皮肤是用户唯一的自救办法，只给「重新加载」等于让他一直重试同一个坏皮肤。
    const available = menuModels(await listModels().catch(() => [] as ModelChoice[]));
    const rescueHandlers = {
      ...survivalHandlers,
      onModel: (choice: ModelChoice) => void (async () => {
        log({ event: "menu:model:rescue", dir: choice.dir, source: choice.source });
        // 用户明确挑了一个 —— 把「本会话已自动回退过」的标记清掉，
        // 这一次值得重新给一次自动回退的额度（新目标要是也坏了，还能再退一步）。
        try { sessionStorage.removeItem("echo.modelRecoveryTried"); } catch { /* 忽略 */ }
        await rememberModel(choice.dir, choice.source);   // 落盘完再重载
        const params = new URLSearchParams(location.search);
        params.set("model", choice.dir);
        location.search = params.toString();
      })(),
      onGallery: () => void invoke("open_tool_window", { name: "gallery" }).catch(console.error),
    };
    openContextMenu = () => void buildFallbackMenu(rescueHandlers, log, "failed", available, language())
      .then(menu => menu.popup()).catch(console.error);
    // 「一个皮肤都没装」和「这个皮肤加载失败」是两回事。不随包分发皮肤之后，
    // 前者是**新用户的正常首启状态**，用报错界面迎接他等于告诉他应用坏了。
    const installed = await invoke<InstalledModel[]>("list_installed_models").catch(() => [] as InstalledModel[]);
    root.innerHTML = installed.length === 0
      ? `<div class="fallback onboarding">`
        + `<label class="onboarding-language"><span>Language</span><select data-act="onboarding-language"><option value="zh-CN">中文</option><option value="en">English</option></select></label>`
        + `<b data-onboarding="title"></b><p><span data-onboarding="description"></span><strong data-onboarding="emphasis"></strong><span data-onboarding="suffix"></span></p>`
        + `<div class="onboarding-drop" data-act="drop-model">把模型文件夹拖到这里</div>`
        + `<div class="fallback-actions"><button data-act="download-model">下载免费模型</button></div></div>`
      : `<div class="fallback"><b>${FAILURE_TEXT[language()].title}</b><p>${escapeHtml(String(error))}</p>`
        + `<p>${FAILURE_TEXT[language()].detail}</p>`
        // 按钮而不是只写「去右键菜单里换」：这张卡片盖住了整个窗口，
        // 而右键菜单在这种处境下正是用户最想不起来的东西。
        + `<button data-act="pick-model">${FAILURE_TEXT[language()].pick}</button>`
        + `<button data-act="reload">${FAILURE_TEXT[language()].reload}</button></div>`;
    // 没有模型时没有人物包围盒，默认命中策略会把整窗穿透；引导页必须临时整窗可交互。
    void invoke("set_hit_region", { x: 0, y: 0, width: innerWidth, height: innerHeight, mode: "normal", trackCursor: false, maskCols: 0, maskRows: 0, maskBits: [] })
      .catch(error => log({ event: "onboarding:hit-region:error", error: String(error).slice(0, 200) }));
    const locale = language();
    // 两张卡都盖住整窗：没有顶栏的话窗口拖不动、也看不到任何关闭入口（右键菜单里有「退出」，
    // 但没人猜得到）。语言下拉一并收进顶栏，省掉原来给它留的那 54px 空白。
    const card = root.querySelector<HTMLElement>(".fallback");
    if (card) {
      const languageLabel = root.querySelector<HTMLElement>(".onboarding-language") ?? undefined;
      card.prepend(cardBar(locale, { label: CARD_TEXT[locale].quit, run: () => void getCurrentWindow().close() }, languageLabel));
    }
    const languageSelect = root.querySelector<HTMLSelectElement>('[data-act="onboarding-language"]');
    if (languageSelect) {
      languageSelect.value = locale; applyOnboardingLanguage(locale);
      languageSelect.addEventListener("change", () => {
        const next = languageSelect.value === "en" ? "en" : "zh-CN";
        rememberLanguage(next); applyOnboardingLanguage(next);
        // 换语言等于换一份文案，长度跟着变 —— 重新量一次，否则中文放得下的窗口装不下英文
        if (card) void fitWindowToCard(card, { center: true }).then(claimWholeWindow).catch(() => {});
      });
    }
    // 窗口变大之后命中区还是老的那一块 —— 卡片长出来的部分会**穿透**，用户点不到
    // 「下载免费模型」，鼠标从它上面划过去也不会有反应。撑完再报一次。
    const claimWholeWindow = () => void invoke("set_hit_region", {
      x: 0, y: 0, width: innerWidth, height: innerHeight,
      mode: "normal", trackCursor: false, maskCols: 0, maskRows: 0, maskBits: [],
    }).catch(error => log({ event: "onboarding:hit-region:error", error: String(error).slice(0, 200) }));

    // 文案填完才量得准。装上模型之后窗口不会自己变回去 —— 成功那条路上的 applyScale
    // 负责收回来（所以那一句不能再「等于 100 就跳过」）。
    if (card) {
      await fitWindowToCard(card, { center: true }).catch(error =>
        log({ event: "onboarding:fit:error", error: String(error).slice(0, 200) }));
      claimWholeWindow();
    }
    root.querySelector('[data-act="download-model"]')?.addEventListener("click", () => void invoke("open_in_browser", {
      url: "https://www.live2d.com/en/learn/sample/momose-hiyori/",
    }).catch(console.error));
    // 引导页自己就是拖放区：原来这里放的是「打开设置」+「装好了，重新加载」两个按钮，
    // 用户要走「开设置 → 切到模型页 → 拖 → 关设置 → 回来点重新加载」五步。
    // 而这一屏出现的时刻，用户手上正拿着那个文件夹 —— 直接接住它就行。
    const dropZone = root.querySelector<HTMLElement>('[data-act="drop-model"]');
    if (dropZone) {
      const copy = () => ONBOARDING_TEXT[language()];
      const say = (text: string, busy: boolean, kind = "") => {
        dropZone.textContent = text;
        dropZone.dataset.busy = busy ? "1" : "";
        dropZone.className = `onboarding-drop ${kind}`;
      };
      // `getCurrentWebview()` 在非 Tauri 环境下**同步抛错**，`.catch()` 接不住（见 settings.ts 同款注释）
      try {
        void getCurrentWebview().onDragDropEvent(async event => {
          const path = droppedPath(event.payload);
          if (!path) {
            const over = event.payload.type === "enter" || event.payload.type === "over";
            dropZone.classList.toggle("over", over);
            return;
          }
          dropZone.classList.remove("over");
          say(copy().installing, true);
          try {
            const installed = await invoke<{ dir: string }>("install_model", { path });
            log({ event: "onboarding:installed", dir: installed.dir });
            // 装完直接选中并重载 —— 用户已经表达了「就用这个」，再让他自己去菜单里挑一次是多余的
            rememberModel(installed.dir, "installed");
            say(copy().installed, true, "ok");
            location.reload();
          } catch (error) {
            log({ event: "onboarding:install:error", error: String(error).slice(0, 200) });
            say(errorMessage(error, language()), false, "error");
            // 报完错回到可再试的状态，否则用户不知道还能不能再拖
            setTimeout(() => { if (dropZone.dataset.busy !== "1") say(copy().drop, false); }, 4000);
          }
        }).catch(console.error);
      } catch (error) {
        log({ event: "onboarding:drag-drop:unavailable", error: String(error).slice(0, 200) });
      }
    }
    // 复用同一个菜单：卡片上的按钮和右键是同一条路，不必再写一套选择界面
    root.querySelector('[data-act="pick-model"]')?.addEventListener("click",
      event => openContextMenu?.(event as MouseEvent));
    // 菜单在 boot 开头就装了最小版（设置/回中央/退出），这里不用再补 —— 那才是唯一的退路。
  } }
async function installMenu(model: Live2DAvatarModel, audio: AudioSourceController, avatarSource: AvatarSource,
                          applyStateSource: (source: StateSource) => void): Promise<void> {
  const dir = currentModelDir();
  const [inventory, initialModels, installed] = await Promise.all([
    loadInventory(avatarSource.baseUrl, model.modelFile ?? "").catch(error => { log({ event: "menu:inventory:error", error: String(error) }); return { motions: [], expressions: [] }; }),
    listModels().catch(() => [] as ModelChoice[]),
    invoke<InstalledModel[]>("list_installed_models").catch(() => [] as InstalledModel[]),
  ]);
  // 作者给零件起的名字（清洗时从 cdi3 / vtube.json 读好的）。状态条上显示的就是这个，
  // 不然用户看到的是「播放 F1」这种自己也不知道是什么的东西。
  const installedEntry = installed.find(item => item.dir === dir);
  const displayNames = installedEntry?.displayNames ?? {};
  const switches: SwitchTable = installedEntry?.switches ?? {};
  let hiddenModels = readHiddenModels();
  let models = menuModels(initialModels, hiddenModels);
  let alwaysOnTop = prefs.read("alwaysOnTop", 1) === 1, clickThrough = prefs.read("clickThrough", 0) === 1;
  let focus = prefs.read("focus", 0) === 1, snapBottom = prefs.read("snapBottom", 0) === 1;
  const qualities = Object.keys(RENDER_SCALE) as RenderQuality[];
  const storedQuality = quality() as RenderQuality | null;
  let qualityChoice: RenderQuality = storedQuality && qualities.includes(storedQuality) ? storedQuality : "高";
  let fps = prefs.read("fps", 30) === 60 ? 60 : 30, eyeTracking = prefs.read("eyeTracking", 0) === 1;
  if (qualityChoice !== "高") model.setQuality(qualityChoice);
  model.setMaxFPS(fps);
  let audioSource: AudioSource = audio.current;
  // 菜单打勾用的副本；真正驱动轮询的是 boot 里那个，两边都以 prefs 为准，不会漂。
  let stateSource = readStateSource();
  const bottomSnap = installBottomSnap(() => snapBottom);
  model.setFocusZoom(focusZoomFromPercent(focusPercent()), hasFocusPercent());
  status.dataset.pos = statusPosition();
  if (focus) model.setFraming("focus");
  if (snapBottom) void bottomSnap.snap();
  // 表情与动作合成一张表：每一项绑一个触发方式（单击 / 双击 / 全局快捷键），
  // 同一个触发绑多项就在它们之间随机。见 actions.ts。
  const actions = listActions(inventory, displayNames, switches);
  let triggers: Record<string, Trigger> = readStringMap(triggerMapKey(dir));
  if (!hasStored(triggerMapKey(dir))) {
    // 1.0 的名单迁移一次（旧键留着不动，万一用户降级回去还在）；从来没设过的模型给默认值
    triggers = hasStored(expressionPoolKey(dir)) || hasStored(motionPoolKey(dir))
      ? migrateTriggers(actions, readPool(expressionPoolKey(dir)) ?? [], readPool(motionPoolKey(dir)) ?? [])
      : defaultTriggers(actions);
  }
  let aliases = readStringMap(aliasMapKey(dir));
  let idleActions: string[] = readPool(idleActionPoolKey(dir)) ?? actions.map(item => item.key);
  // 常驻：每帧按住这些项对应的参数。互不冲突（实测六样同时开都在），所以不做任何互斥判断。
  let heldActions: string[] = readPool(heldActionPoolKey(dir)) ?? [];
  const applyHeld = () => model.setHeldParameters(heldParameters(actions, heldActions));
  applyHeld();
  let lastActionKey: string | undefined;

  /**
   * 播一项，不管它是表情还是动作 —— 触发方式那一列不再区分两者。
   *
   * `manual` 决定要不要在状态条上报一句。状态条只报**用户亲自触发**的：
   * 闲置自治每隔几十秒就自己动一下，一起报的话状态条会一直在跳，用户以为 agent 在干活。
   */
  const runAction = (item: ActionItem, source: string, manual = true) => {
    lastActionKey = item.key;
    model.lookAhead();
    const label = actionLabel(item, aliases);
    if (manual) showManualActivity(item.kind === "motion" ? "motion" : "expression", label);
    if (item.motion) model.playMotion(item.motion[0], item.motion[1]);
    else model.playExpression(item.origin);
    log({ event: `${source}:action`, key: item.key, label });
  };
  const fire = (trigger: Trigger, source: string) => {
    const item = pickAction(actionsFor(actions, triggers, trigger), lastActionKey);
    if (item) runAction(item, source);   // 没绑任何项 = 用户把这个触发关掉了，什么都不做
  };
  clickThroughHint = clickThrough;
  shell.dataset.clickThrough = String(clickThrough);
  const scalePercent = prefs.read("scale", 100), opacityPercent = prefs.read("opacity", 100);
  // 🔴 **无条件**应用，哪怕是 100%。引导页会把窗口撑大，而装上模型只是重新加载页面 ——
  // 窗口是操作系统的，不会跟着页面变回去。这一句就是那条回程。
  await applyScale(scalePercent).catch(error => log({ event: "menu:scale:error", error: String(error) }));
  if (opacityPercent !== 100) model.setOpacity(opacityPercent / 100);
  // 口型两项**无条件应用**，不像上面两个那样「等于默认值就跳过」——
  // 阈值是模块级的，跳过就等于把上一次会话留下的值带进来。
  setLipSensitivity(lipSensitivityPercent());
  model.setMouthAmplitude(mouthAmplitudePercent() / 100);
  model.setSemanticMotions(readStateMotions(dir));
  model.setSemanticExpressions(readStateExpressions(dir));
  stateLabels = readStateLabels();
  // 🔴 每次启动都重申一遍。开关文件在临时目录里，而临时目录会被系统清扫 —— 清掉之后
  // hook 回到「默认关」，于是一个明明开着的功能悄悄不动了，界面上还打着勾。
  void invoke("set_activity_detail", { enabled: detailEnabled })
    .catch(error => log({ event: "activity-detail:assert:error", error: String(error).slice(0, 200) }));

  const buildState = () => ({
    models, currentDir: dir, inventory, audioSource, stateSource,
    alwaysOnTop, clickThrough, focus, snapBottom, eyeTracking, language: uiLanguage,
  });

  // 画质与帧率不再进右键菜单（不是会经常改的东西），只由设置窗口驱动
  const applyQuality = (next: string) => {
    if (!qualities.includes(next as RenderQuality)) return;
    qualityChoice = next as RenderQuality;
    rememberQuality(next);
    model.setQuality(qualityChoice);
  };
  const applyFps = (value: number) => {
    if (!FPS_CHOICES.includes(value as 30 | 60)) return;
    fps = value; prefs.write("fps", value);
    model.setMaxFPS(value);
  };

  // 设置窗口改了什么就即时应用：两个窗口读写同一份 config.json（负责持久化），
  // 这条事件只负责「立刻生效」，省得用户改完还要重启。
  void listen<SettingsChange>(SETTINGS_EVENT, ({ payload }) => {
    if (payload.scalePercent !== undefined) void applyScale(payload.scalePercent).catch(error => log({ event: "settings:scale:error", error: String(error) }));
    if (payload.opacityPercent !== undefined) { prefs.write("opacity", payload.opacityPercent); model.setOpacity(payload.opacityPercent / 100); }
    // 口型两项都是全局设置。灵敏度落在模块级阈值上，三种音源共用的 GlobalLevelTracker
    // 会立刻读到；张嘴幅度落在 setVocalLevel，那是三种音源唯一都经过的点。
    if (payload.lipSensitivityPercent !== undefined) { prefs.write("lipSensitivity", payload.lipSensitivityPercent); setLipSensitivity(payload.lipSensitivityPercent); }
    if (payload.mouthAmplitudePercent !== undefined) { prefs.write("mouthAmplitude", payload.mouthAmplitudePercent); model.setMouthAmplitude(payload.mouthAmplitudePercent / 100); }
    if (payload.focusPercent !== undefined) { prefs.write("focusPercent", payload.focusPercent); model.setFocusZoom(focusZoomFromPercent(payload.focusPercent), true); }
    if (payload.statusPosition) { rememberStatusPosition(payload.statusPosition); status.dataset.pos = payload.statusPosition; }
    if (payload.idleDelaySeconds !== undefined) { rememberIdleDelay(payload.idleDelaySeconds); applyIdleDelay(payload.idleDelaySeconds); }
    if (payload.quality) applyQuality(payload.quality);
    if (payload.fps) applyFps(payload.fps);
    // 录完一个组合键会在同一条里带上「不再暂停」和新的绑定；两样都收完再注册一次，
    // 不然会先在「还暂停着」的状态下白跑一趟。
    let refreshShortcuts = false;
    if (payload.triggers) { triggers = payload.triggers; refreshShortcuts = true; }
    if (payload.aliases) aliases = payload.aliases;
    if (payload.idleActions) idleActions = payload.idleActions;
    if (payload.heldActions) { heldActions = payload.heldActions; applyHeld(); }
    // 设置页正在录制组合键：让出已注册的热键，否则用户想录的那个会先被自己截走
    if (payload.shortcutsSuspended !== undefined) { shortcutsSuspended = payload.shortcutsSuspended; refreshShortcuts = true; }
    if (refreshShortcuts) void applyShortcuts();
    if (payload.stateMotions) model.setSemanticMotions(payload.stateMotions);
    if (payload.stateExpressions) model.setSemanticExpressions(payload.stateExpressions);
    // 状态栏此刻显示的就是上一个状态的名字 —— 改完不重画，用户要等下一次状态变化才看得到
    if (payload.stateLabels) { stateLabels = payload.stateLabels; renderStatus(); }
    // 关掉时立刻把已经显示着的那一行也抹掉 —— 等下一次状态变化才消失，看起来像没生效
    if (payload.activityDetail !== undefined) {
      detailEnabled = payload.activityDetail;
      if (!detailEnabled) doing = "";
      renderStatus();
    }
    if (payload.language) { uiLanguage = payload.language; renderStatus(); }
    if (payload.hiddenModels) hiddenModels = payload.hiddenModels;
    log({ event: "settings:applied", keys: Object.keys(payload) });
  }).catch(console.error);

  const handlers: NativeMenuHandlers = {
    onExpression: name => model.playExpression(name),
    onMotion: (group, index) => model.playMotion(group, index),
    onGallery: () => {
      // 改走应用自己的窗口而不是系统浏览器：浏览器里没有 Tauri 命令，画廊也就列不出用户装的皮肤。
      void invoke("open_tool_window", { name: "gallery" })
        .then(() => log({ event: "menu:gallery" }))
        .catch(error => log({ event: "menu:gallery:error", error: String(error).slice(0, 200) }));
    },
    onModel: choice => void (async () => {
      // 这一步会重载页面，日志必须先落盘，否则切皮肤在日志里完全没有痕迹。
      log({ event: "menu:model", dir: choice.dir, source: choice.source });
      await rememberModel(choice.dir, choice.source);   // 落盘完再重载，否则 modelSource 会丢
      const params = new URLSearchParams(location.search);
      params.set("model", choice.dir);
      location.search = params.toString();
    })(),
    onAlwaysOnTop: on => { alwaysOnTop = on; prefs.write("alwaysOnTop", on); void getCurrentWindow().setAlwaysOnTop(on).catch(error => log({ event: "menu:always-on-top:error", error: String(error) })); },
    onSettings: () => void invoke("open_tool_window", { name: "settings" })
      .catch(error => log({ event: "menu:settings:error", error: String(error).slice(0, 200) })),
    onEyeTracking: on => {
      eyeTracking = on; prefs.write("eyeTracking", on);
      if (!on) model.lookAhead();   // 关掉时收回视线，否则僵在最后位置
      log({ event: "menu:eye-tracking", on });
      reportHitRegion();            // 立即让 Rust 侧开始/停止上报光标
    },
    onFocus: on => {
      focus = on; prefs.write("focus", on);
      model.setFraming(on ? "focus" : "full");
      log({ event: "menu:focus", on });
    },
    onSnapBottom: on => {
      snapBottom = on; prefs.write("snapBottom", on);
      log({ event: "menu:snap-bottom", on });
      if (on) void bottomSnap.snap();
    },
    onStateSource: source => {
      stateSource = source;
      writeStateSource(source);
      applyStateSource(source);
      log({ event: "semantic:source", source });
    },
    onAudioSource: source => {
      const selected = source === "file" ? new Promise<File | null>(resolve => {
        const input = document.createElement("input"); input.type = "file"; input.accept = "audio/*";
        input.hidden = true; document.body.append(input);
        const finish = (file: File | null) => { input.remove(); resolve(file); };
        input.addEventListener("change", () => finish(input.files?.[0] ?? null), { once: true });
        input.addEventListener("cancel", () => finish(null), { once: true });
        input.click();
      }) : Promise.resolve(null);
      void selected.then(file => {
        if (source !== "file") return audio.start(source);
        if (!file) return;
        log({ event: "menu:audio-file:selected", name: file.name, size: file.size, type: file.type });
        return audio.playFile(file);
      }).then(() => {
        audioSource = source;
        // `file` 指向一次性挑的文件，重启后那个选择没有意义，不持久化。
        if (source !== "file") writeAudioSource(source);
        log({ event: "menu:audio-source", source });
      }).catch(error => log({ event: "menu:audio-source:error", source, error: String(error).slice(0, 200) }));
    },
    onClickThrough: on => {
      clickThrough = on; clickThroughHint = on; shell.dataset.clickThrough = String(on); prefs.write("clickThrough", on);
      log({ event: "menu:click-through", on });
      renderStatus();
    },
    onResetPosition: () => void getCurrentWindow().center().catch(error => log({ event: "menu:center:error", error: String(error) })),
    onQuit: () => void getCurrentWindow().close(),
  };

  const reportHitRegion = startHitReporting(model, () => (clickThrough ? "through" : "normal"), () => eyeTracking);
  void listen<[number, number]>("cursor-position", event => { if (eyeTracking) model.lookAt(event.payload[0], event.payload[1]); });

  // 单击、双击各自从绑在它上面的那些项里随机挑一个播。
  // 拖动已改为超过阈值才触发，否则这里收不到 click / dblclick。
  let pendingClick: number | undefined;
  const cancelPendingClick = () => { if (pendingClick !== undefined) { clearTimeout(pendingClick); pendingClick = undefined; } };

  // 菜单内的点击由菜单自己 stopPropagation 截停，这里不再判断来源
  // （就地重绘会让 target 脱离 DOM，closest 判断不可靠）。
  shell.addEventListener("click", () => {
    cancelPendingClick();
    pendingClick = window.setTimeout(() => { pendingClick = undefined; fire(CLICK, "click"); }, CLICK_EXPRESSION_DELAY_MS);
  });

  shell.addEventListener("dblclick", () => { cancelPendingClick(); fire(DBLCLICK, "dblclick"); });

  /**
   * 注册全局快捷键。桌宠常年置顶、大部分时间点击穿透，几乎从不持有焦点 ——
   * 应用内 keydown 收不到任何东西，只能走系统级注册。
   *
   * **注册失败必须显式说**：被别的程序占了是常事，静默失效的表现是「设了没反应」，
   * 用户无从判断是自己设错了还是程序坏了。失败的组合广播给设置页，由它标在那一行上。
   */
  let shortcutsSuspended = false;
  /**
   * 注册是异步的，而设置页一次操作会连着广播好几条（录完一个组合键会同时发「不再暂停」和
   * 新的绑定）。两次注册叠在一起跑会互相踩：A 反注册、B 反注册、A 注册、B 注册 →
   * B 报「HotKey already registered」，那一行会被误标成红的。所以串起来一个一个跑。
   */
  let shortcutWork: Promise<void> = Promise.resolve();
  const applyShortcuts = () => {
    shortcutWork = shortcutWork.then(registerShortcuts, registerShortcuts);
    return shortcutWork;
  };
  const registerShortcuts = async () => {
    await unregisterAll().catch(error => log({ event: "shortcut:unregister-all:error", error: String(error).slice(0, 200) }));
    if (shortcutsSuspended) { log({ event: "shortcut:suspended" }); return; }
    const failed: string[] = [];
    for (const accelerator of shortcutsIn(triggers)) {
      try {
        await register(accelerator, event => {
          // Pressed / Released 都会回调，不筛的话一次按键播两下
          if (event.state === "Pressed") fire(accelerator, "shortcut");
        });
      } catch (error) {
        failed.push(accelerator);
        log({ event: "shortcut:register:failed", accelerator, error: String(error).slice(0, 200) });
      }
    }
    void emit(SHORTCUT_STATUS_EVENT, { failed });
    log({ event: "shortcut:registered", count: shortcutsIn(triggers).length - failed.length, failed: failed.length });
  };
  void applyShortcuts();

  openContextMenu = () => void (async () => {
    try {
      // 每次右键重建：勾选态要反映当前值，而菜单项的 checked 是建的时候定死的。
      // 顺带重扫皮肤目录 —— 用户可能直接把皮肤拖进了文件夹，不需要额外的「刷新」入口。
      // 弹出位置、超出窗口、点任何地方收起，全部由系统负责 —— 这正是换原生菜单的目的。
      models = menuModels(await listModels().catch(() => models), hiddenModels);
      const menu = await buildNativeMenu(buildState(), handlers, log);
      await menu.popup();
    } catch (error) {
      log({ event: "menu:popup:error", error: String(error).slice(0, 200) });
    }
  })();
  log({ event: "menu:ready", models: models.length });

  /**
   * 闲置自治：没人说话、Hermes 也没在忙时，自己动一动。
   *
   * 动作只从**随机名单**里挑 —— 用户在设置里关掉的动作，这里不该偷偷播。
   * 视线只在「眼睛跟随鼠标」关着时才动：开着时鼠标是主人，自治插一脚会互相打架。
   */
  const idle = new IdleAutonomy((action, gaze) => {
    if (action === "gaze") {
      // 跳过也要留痕：不然排查时看不出是「调度器没跑」还是「跑了但让位给鼠标」
      if (shell.dataset.speaking === "true" || eyeTracking) { log({ event: "idle:gaze", skipped: shell.dataset.speaking === "true" ? "speaking" : "eye-tracking" }); return; }
      model.lookToward(gaze.x, gaze.y);
      log({ event: "idle:gaze", x: Number(gaze.x.toFixed(2)), y: Number(gaze.y.toFixed(2)) });
      return;
    }
    // 闲置有自己的名单：打哈欠适合自己没事时做，却不适合当「你点我一下」的回应。
    // （1.0 里这一列写进了配置却没人读，闲置实际用的是双击那份名单。）
    const item = pickAction(actions.filter(action => idleActions.includes(action.key)), lastActionKey);
    if (!item) return;  // 名单被全部关掉 = 不自作主张
    runAction(item, "idle", false);
  });
  notifyIdleBusy = () => idle.notifyBusy();

  /** 0 秒 = 关闭。秒数本身兼任开关，不再另设一个会互相矛盾的开关。 */
  const applyIdleDelay = (seconds: number) => {
    if (seconds <= 0) { idle.stop(); log({ event: "idle:disabled" }); return; }
    idle.setGrace(seconds * 1000);
    idle.start();
    log({ event: "idle:started", graceSeconds: seconds });
  };
  applyIdleDelay(idleDelaySeconds());

  // 用户正在跟她互动时别插嘴。pointerdown 一条覆盖单击 / 双击 / 拖动 / 右键；
  // **不监听 pointermove** —— 鼠标只是路过也算打扰的话，把它停在窗口上她就再也不动了。
  shell.addEventListener("pointerdown", () => {
    notifyIdleBusy();
    // 自治可能把视线歪在一边；人来了还盯着别处很怪，收回正前方。
    // 开着眼睛跟随时不用管 —— 鼠标一动就接管了。
    // 自治的内部视线状态也要一起归零，否则下一次它会从那个旧位置继续算"该挪多远"。
    if (!eyeTracking) { model.lookAhead(); idle.syncGaze({ x: 0, y: 0 }); }
  });
}

/**
 * 人物包围盒随动作变化，定时上报给 Rust；Rust 轮询全局光标位置决定窗口是否穿透。
 * 默认模式人物可点、其余穿透；穿透模式全部穿透，光标在人物上停留 3 秒才临时恢复交互（秒数须与 lib.rs 的 DWELL_MS 同步）
 * （穿透期间网页收不到任何事件，故判定只能放在 Rust 侧）。
 */
function startHitReporting(model: Live2DAvatarModel, mode: () => "normal" | "through", trackCursor: () => boolean): () => void {
  const report = () => {
    // 接入向导是一张盖住整个窗口的卡片。人物包围盒之外默认是穿透的，
    // 不整窗放开的话卡片上的按钮一个都点不动（首启引导页同一条道理）。
    if (wizardOpen) {
      void invoke("set_hit_region", { x: 0, y: 0, width: innerWidth, height: innerHeight, mode: "normal", trackCursor: false, maskCols: 0, maskRows: 0, maskBits: [] })
        .catch(error => log({ event: "hit-region:error", error: String(error).slice(0, 200) }));
      return;
    }
    // HTML 菜单时代这里有一条「菜单打开时整窗可交互」的特例。原生菜单不需要：
    // 它由系统绘制并自行抓取事件，实机日志确认各项回调照常触发，与窗口穿透状态无关。
    // hitArea 带占位网格：包围盒里的空白（腋下、两腿之间、发缝）也要能穿透。
    // 抽不出像素时它退化成 bounds() 的矩形，此时 cols/rows 为 0，Rust 侧照旧整盒命中。
    const box = model.hitArea();
    if (!box) return;
    void invoke("set_hit_region", {
      x: box.x, y: box.y, width: box.width, height: box.height, mode: mode(), trackCursor: trackCursor(),
      maskCols: box.cols ?? 0, maskRows: box.rows ?? 0, maskBits: box.bits ?? [],
    }).catch(error => log({ event: "hit-region:error", error: String(error).slice(0, 200) }));
  };
  report();
  setInterval(report, HIT_REPORT_MS);
  return report;
}

void boot();
