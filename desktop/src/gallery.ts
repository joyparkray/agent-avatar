// Agent Avatar · 皮肤画廊（仅浏览器）
// 加皮肤时用来一次性核对：能否加载、动作/表情清单、聚焦判定是否合适、avatar.json 是否指向有效动作。
// 桌面端那套（透明窗口 / 命中判定 / 吸附）全依赖 Tauri，此页刻意不复刻。
import "./pixi";
import { Application } from "pixi.js";
import { Live2DModel } from "@jannchie/pixi-live2d-display/cubism4";
import { focusFrame, autoFocusZoom, type Framing } from "./dock";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadInventory, loadModelIndex, motionRefs, type ModelInventory } from "./inventory";
import { loadManifest } from "./manifest";
import type { AvatarManifest } from "./types";
import { language, loadPrefs, UNSUPPORTED_CUBISM_TEXT, type Language } from "./prefs";
import { installGlobalDiagnostics } from "./diagnostics";

/**
 * 画廊出错时原来只剩**一片黑**：背景是深色、canvas 空的、没有任何提示，也不落日志
 * （主窗口有 installGlobalDiagnostics，这里一直没有）。用户只能来问，而我们连问题在哪都不知道。
 * 现在两件事一起做：写进和主窗口同一个日志文件，并把错误摆到页面上。
 */
installGlobalDiagnostics(event => void invoke("log_event", { event: JSON.stringify({ window: "gallery", ...event }) }).catch(() => {}));
const errorBox = document.getElementById("err")!;
const showFatal = (what: string, error: unknown): void => {
  const detail = error instanceof Error ? error.message : String(error);
  errorBox.textContent = `${what}\n${detail}`;
  console.error(what, error);
};
addEventListener("error", event => showFatal(t9n("画廊出错了", "The gallery hit an error"), (event as ErrorEvent).error ?? (event as ErrorEvent).message));
addEventListener("unhandledrejection", event => showFatal(t9n("画廊出错了", "The gallery hit an error"), (event as PromiseRejectionEvent).reason));

/** 画廊与右键菜单同一套写法：一处给中英两句，不另建文案表（这里的词条不多）。 */
let locale: Language = "zh-CN";
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const t9n = (zh: string, en: string): string => (locale === "en" ? en : zh);

interface Cell { dir: string; label: string; model: Live2DModel; manifest: AvatarManifest; inventory: ModelInventory; base: [number, number]; issues: string[] }

/** 每行固定高度，皮肤多了往下排、浏览器下拉即可。 */
const CELL_HEIGHT = 780;
/** 行内四周留白。 */
const CELL_PADDING = 24;
/** 人物高度占行内可用高度的比例。与行高分开，这样加高行距不会连带把人物撑大。 */
const CONTENT_FILL = 0.5;
/** 左侧信息卡宽度，人物占右侧剩余空间。 */
const CARD_WIDTH = 230;
/**
 * 假定人物约占皮肤画布高度的这个比例。
 * Live2D 画布四周为动作摆幅预留了大片透明区，`model.getBounds()` 返回的是画布框而非人物范围，
 * 直接按它排版人物会显得很小 —— 实测 Haru 的人物只占画布高度的 51%。
 * 曾尝试逐皮肤读像素实测，但依赖渲染时序（隐藏标签页下 ticker 行为不定）反复给出错误值，
 * 故改用这个按实测标定的常量：足够准，且行为可预测。人物偏小就把它调小。
 */
const ASSUMED_CONTENT_FRACTION = 0.5;
/**
 * 假定人物顶端位于画布高度的这个位置：该点会被对齐到行的上缘留白。
 * **方向容易搞反**：这个值估大 → 皮肤被往上推 → 切掉头顶；估小只是多留一点头顶空间。
 * 各皮肤的实际值不同（Haru 明显小于 Hiyori），故取偏小的安全值，宁可空一点也不切头。
 */
const ASSUMED_CONTENT_TOP = 0.04;

const grid = document.getElementById("grid")!;
const stage = document.getElementById("stage")!;
const cards = document.getElementById("cards")!;
const status = document.getElementById("status")!;
const framingButton = document.getElementById("framing") as HTMLButtonElement;

/** 一个 Application、一个 stage 承载全部皮肤 —— 每个皮肤单开一个 App 会各占一个 WebGL
 *  上下文，浏览器有上限（Chrome 约 16），超出后会静默丢弃最早的上下文，表现为皮肤莫名变黑。 */
const app = new Application();
await app.init({ backgroundAlpha: 0, antialias: false, autoDensity: true, resolution: devicePixelRatio || 1, preference: "webgl" });
stage.append(app.canvas);

/** avatar.json 里的动作索引/表情名是否在 model3.json 中真实存在（越界过一次，值得每次都看）。 */
function manifestIssues(manifest: AvatarManifest, inventory: ModelInventory): string[] {
  const issues: string[] = [];
  for (const [state, [group, index]] of Object.entries(manifest.motions ?? {}) as [string, [string, number]][]) {
    const found = inventory.motions.find(motion => motion.group === group);
    if (!found) issues.push(t9n(`${state} → 组 ${group} 不存在`, `${state} → group ${group} does not exist`));
    else if (index >= found.count) issues.push(t9n(`${state} → ${group}[${index}] 越界（0..${found.count - 1}）`, `${state} → ${group}[${index}] is out of range (0..${found.count - 1})`));
  }
  for (const [state, name] of Object.entries(manifest.expressions ?? {}) as [string, string][]) {
    if (!inventory.expressions.includes(name)) issues.push(t9n(`${state} → 表情 ${name} 不存在`, `${state} → expression ${name} does not exist`));
  }
  return issues;
}

/** 画廊条目：随包的和用户装的走不同前缀；后者可能没有 avatar.json，要靠 model3 合成。 */
interface GalleryEntry { dir: string; label: string; source: "bundled" | "installed"; model3?: string }

async function loadCell(entry: GalleryEntry): Promise<Cell> {
  const { dir, label } = entry;
  const baseUrl = entry.source === "installed" ? `/user-models/${dir}` : `/models/${dir}`;
  const manifest = await loadManifest({ baseUrl, manifest: "avatar.json", model3: entry.model3 });
  const inventory = await loadInventory(baseUrl, manifest.model);
  const model = await Live2DModel.from(`${baseUrl}/${manifest.model}`, { ticker: app.ticker, autoInteract: false });
  // pixi-live2d-display 1.4.0 用 Pixi 的**逻辑**尺寸设置 Cubism 的裸 GL 视口，
  // Retina（resolution=2）下只会渲染到物理缓冲的左下四分之一，表现为人物被压到页面底部。
  // 与桌面端 Live2DAvatarModel.installPhysicalViewport() 是同一个修法。
  const internal = model.internalModel as unknown as { viewport: number[]; draw(gl: WebGLRenderingContext | WebGL2RenderingContext): void };
  const draw = internal.draw.bind(internal);
  internal.draw = gl => {
    internal.viewport[2] = gl.drawingBufferWidth;
    internal.viewport[3] = gl.drawingBufferHeight;
    draw(gl);
  };
  model.anchor.set(0.5, 0.5);
  const issues = manifestIssues(manifest, inventory);
  // Cubism 5.1 的离屏合成当前渲染器画不了（见 Live2DAvatarModel.offscreenCount）。
  // 画廊是「这个模型能不能用」的答案页，这条比动作越界更该出现在这里。
  const offscreens = (model.internalModel?.coreModel as
    { getModel?: () => { offscreens?: { count?: number } } } | undefined)?.getModel?.()?.offscreens?.count ?? 0;
  if (offscreens > 0) issues.push(UNSUPPORTED_CUBISM_TEXT[language()]);
  return { dir, label, model, manifest, inventory, base: [model.width, model.height], issues };
}

let framing: Framing = "full";

function layout(cells: Cell[]): boolean {
  const width = grid.clientWidth || innerWidth;
  const areaLeft = CELL_PADDING + CARD_WIDTH + CELL_PADDING;
  const areaWidth = width - areaLeft - CELL_PADDING;
  const areaHeight = CELL_HEIGHT - CELL_PADDING * 2;
  // 容器尚未取得尺寸（隐藏标签页等）时直接跳过，否则会算出负的缩放
  if (areaWidth <= 0 || areaHeight <= 0) return false;

  grid.style.height = `${cells.length * CELL_HEIGHT}px`;
  app.renderer.resize(width, cells.length * CELL_HEIGHT);
  cards.innerHTML = "";

  cells.forEach((cell, index) => {
    const cellTop = index * CELL_HEIGHT;
    const [baseWidth, baseHeight] = cell.base;
    const contentHeight = baseHeight * ASSUMED_CONTENT_FRACTION;
    const contentTop = baseHeight * ASSUMED_CONTENT_TOP;
    const zoom = autoFocusZoom(baseWidth, baseHeight);
    // 两种构图只差一个放大倍数；定位统一为「人物顶端对齐到行的上缘留白」。
    const fitScale = Math.min(areaWidth / baseWidth, (areaHeight * CONTENT_FILL) / contentHeight);
    const scale = fitScale * (framing === "focus" ? zoom : 1);
    cell.model.position.set(
      areaLeft + areaWidth / 2,
      cellTop + CELL_PADDING + (baseHeight / 2 - contentTop) * scale,
    );
    cell.model.scale.set(scale);

    const aspect = baseWidth / baseHeight;
    const motions = motionRefs(cell.inventory).length;
    const card = document.createElement("div");
    card.className = "card";
    card.style.left = `${CELL_PADDING}px`;
    card.style.top = `${cellTop + CELL_PADDING}px`;
    card.style.width = `${CARD_WIDTH}px`;
    card.innerHTML =
      // 模型名进 innerHTML 前先转义。后端 `is_safe_dir_name` 已经把目录名限死在
      // ASCII 字母数字/-/_，正常路径塞不进 HTML 特殊字符 —— 这是纵深防御：
      // 万一以后放宽了命名规则，别让这里成为第二处要记得改的地方。
      `<b>${escapeHtml(cell.label)}<span style="color:#8b95a5;font-weight:400"> · ${escapeHtml(cell.dir)}</span></b>` +
      `<dl><dt>${t9n("尺寸", "Size")}</dt><dd>${Math.round(baseWidth)}×${Math.round(baseHeight)}</dd>` +
      `<dt>${t9n("宽高比", "Aspect")}</dt><dd>${aspect.toFixed(2)}</dd>` +
      `<dt>${t9n("聚焦判定", "Focus")}</dt><dd class="${zoom === 1 ? "focus" : "full"}">${zoom === 1 ? t9n("已是胸像·不裁", "Already a bust · no crop") : t9n(`全身·放大 ${zoom}×`, `Full body · zoom ${zoom}×`)}</dd>` +
      `<dt>${t9n("动作", "Motions")}</dt><dd>${t9n(`${cell.inventory.motions.length} 组 / ${motions} 个`, `${cell.inventory.motions.length} groups / ${motions} total`)}</dd>` +
      `<dt>${t9n("表情", "Expressions")}</dt><dd>${cell.inventory.expressions.length}</dd>` +
      `<dt>manifest</dt><dd class="${cell.issues.length ? "bad" : "focus"}">${cell.issues.length ? t9n(`${cell.issues.length} 处问题`, `${cell.issues.length} issue(s)`) : t9n("有效", "valid")}</dd></dl>` +
      (cell.issues.length ? `<div class="bad" style="margin-top:4px;font-size:11px">${cell.issues.join("<br>")}</div>` : "");
    cards.append(card);
  });
  return true;
}

/** 画廊里也要能看到用户装的皮肤 —— 它现在跑在应用窗口里，拿得到 Tauri 命令。 */
async function galleryEntries(): Promise<GalleryEntry[]> {
  const bundled = (await loadModelIndex().catch(() => []))
    .map(item => ({ ...item, source: "bundled" as const }));
  const installed = await invoke<{ dir: string; label: string; model3: string }[]>("list_installed_models")
    .catch(() => [] as { dir: string; label: string; model3: string }[]);
  return [...bundled, ...installed.map(item => ({ dir: item.dir, label: item.label, source: "installed" as const, model3: item.model3 }))];
}

await loadPrefs();   // 语言从配置来，和设置窗口用同一份
locale = language();
document.documentElement.lang = locale;
{
  const title = t9n("Agent Avatar 模型画廊", "Agent Avatar Model Gallery");
  document.title = title;
  // 与设置窗口同理：`document.title` 不会改原生标题栏；同样要裹 try，
  // `getCurrentWindow()` 在非 Tauri 环境下是同步抛错的。
  try { void getCurrentWindow().setTitle(title).catch(console.error); }
  catch (error) { console.error("setTitle unavailable", error); }
  document.querySelector("#framing")!.textContent = t9n("半身构图", "Bust framing");
}
const entries = await galleryEntries();
if (!entries.length) {
  status.textContent = t9n("没有可用模型", "No models available");
} else {
  const cells: Cell[] = [];
  for (const entry of entries) {
    try {
      const cell = await loadCell(entry);
      app.stage.addChild(cell.model);
      cells.push(cell);
    } catch (error) {
      // 一个模型坏掉不该让整页只剩黑屏：记下来、显示出来，其余照常渲染
      status.textContent = t9n(`${entry.dir} 加载失败：${String(error).slice(0, 120)}`, `${entry.dir} failed to load: ${String(error).slice(0, 120)}`);
      showFatal(t9n(`${entry.dir} 加载失败`, `${entry.dir} failed to load`), error);
    }
  }
  layout(cells);
  status.textContent = t9n(`${cells.length} / ${entries.length} 个模型`, `${cells.length} / ${entries.length} models`);
  // 用 ResizeObserver 而非 window.resize —— 容器尺寸就绪时会补发，隐藏标签页恢复后也能自愈
  new ResizeObserver(() => layout(cells)).observe(grid);
  framingButton.addEventListener("click", () => {
    framing = framing === "full" ? "focus" : "full";
    framingButton.classList.toggle("on", framing === "focus");
    layout(cells);
  });
  (window as unknown as { gallery?: unknown }).gallery = { app, cells };
}
