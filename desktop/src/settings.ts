import "./settings.css";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { droppedPath } from "./drop";
import { loadManifest } from "./manifest";
import {
  defaultEnabledExpressions, defaultEnabledMotions, loadInventory,
  motionKey, motionLabel, motionRefs, type ModelInventory, type MotionRef,
} from "./inventory";
import { FPS_CHOICES, RENDER_SCALE, type RenderQuality } from "./render-quality";
import {
  currentModelDir, DEFAULT_FOCUS_PERCENT, loadPrefs, quality, expressionPoolKey, motionPoolKey, prefs, readPool, writePool,
  idleDelaySeconds, idleExpressionPoolKey, idleMotionPoolKey, rememberIdleDelay, rememberStatusPosition, statusPosition, STATUS_LABELS, STATUS_POSITIONS,
  currentModelSource, language, LANGUAGES, modelBaseUrl, readStateMotions, rememberLanguage, rememberStateMotions,
  readHiddenModels, writeHiddenModels, SETTINGS_EVENT, type Language, type SettingsChange, type StatusPosition,
} from "./prefs";
import { SEMANTIC_STATES, type SemanticState } from "./types";
import { renderConnectors } from "./connectors";
import { errorMessage } from "./errors";

/** 改动即时广播给主窗口；config.json 只负责持久化，不负责生效。 */
const announce = (change: SettingsChange) => void emit(SETTINGS_EVENT, change).catch(console.error);

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const setLabel = (name: string, text: string) => { $(`[data-label="${name}"]`).textContent = text; };

const TEXT: Record<Language, Record<string, string>> = {
  "zh-CN": {
    "tab.general": "通用", "tab.video": "视频", "tab.agent": "Agent", "tab.behavior": "行为", "tab.models": "模型",
    "general.language": "语言", "general.interfaceLanguage": "界面语言", "general.languageHint": "语言切换会立即应用到设置窗口。", "general.statusBar": "状态栏", "general.statusHint": "显示 Agent 当前在做什么，并可调整到不遮挡模型的位置。", "general.position": "位置",
    "video.display": "显示", "video.scale": "缩放", "video.opacity": "透明度", "video.focus": "聚焦范围：显示顶部", "video.focusHint": "仅在右键菜单启用聚焦模式时生效。", "video.rendering": "渲染", "video.renderHint": "降低画质通常比降低帧率更省 GPU。", "video.quality": "画质", "video.fps": "帧率",
    "agent.connectors": "接入", "agent.connectorsHint": "选择你在用的 agent，自动下载并安装对应的 connector；安装后如需手动步骤会显示在下面。", "agent.mapping": "状态与动作", "agent.mappingHint": "为当前模型的每个 Agent 状态选择动作。选择“模型默认”会使用 avatar.json 的映射。", "agent.default": "模型默认",
    "behavior.idle": "闲置自治", "behavior.idleHint": "无人交互且 Agent 空闲时，让形象自己看四周、播放动作或表情。", "behavior.delay": "静置多少秒后开始", "behavior.zero": "填 0 即关闭。", "behavior.random": "随机名单", "behavior.randomHint": "「单击 / 双击」列是你亲自触发的，「闲置」列是没人理它时自己播的。点列标题可全开或全关。", "behavior.motions": "动作", "behavior.expressions": "表情", "behavior.expressionClick": "单击", "behavior.motionDoubleClick": "双击", "behavior.idleActions": "闲置",
    "models.title": "模型", "models.hint": "拖入包含 *.model3.json 的 Cubism 模型文件夹。", "models.drop": "拖模型文件夹到此处", "models.open": "在访达中打开模型文件夹",
    "common.empty": "这个模型没有可用项", "models.empty": "尚未安装模型", "models.hide": "隐藏", "models.delete": "删除", "models.deleteConfirm": "再点一次「确认删除」就会删除模型：", "models.deleteAgain": "确认删除", "models.installing": "安装中…", "models.installed": "已安装", "models.switchHint": "", "models.tauriOnly": "拖放安装需要在 Agent Avatar 应用内使用", "models.unrecognized": "无法识别。",
    ...Object.fromEntries(SEMANTIC_STATES.map(state => [`state.${state}`, state])),
  },
  en: {
    "tab.general": "General", "tab.video": "Video", "tab.agent": "Agent", "tab.behavior": "Behavior", "tab.models": "Models",
    "general.language": "Language", "general.interfaceLanguage": "Interface language", "general.languageHint": "Language changes apply to this settings window immediately.", "general.statusBar": "Status bar", "general.statusHint": "Show what the agent is doing and place the label where it does not cover the avatar.", "general.position": "Position",
    "video.display": "Display", "video.scale": "Scale", "video.opacity": "Opacity", "video.focus": "Focus crop: show top", "video.focusHint": "Only applies when Focus Mode is enabled from the context menu.", "video.rendering": "Rendering", "video.renderHint": "Lowering quality usually saves more GPU power than lowering frame rate.", "video.quality": "Quality", "video.fps": "Frame rate",
    "agent.connectors": "Connectors", "agent.connectorsHint": "Pick the agent you use and install its connector. Any remaining manual step is shown below.", "agent.mapping": "Agent state and motion", "agent.mappingHint": "Choose a motion for each agent state on the current model. Model default uses the avatar.json mapping.", "agent.default": "Model default",
    "behavior.idle": "Idle autonomy", "behavior.idleHint": "Let the avatar look around or play motions and expressions while the agent is idle.", "behavior.delay": "Start after this many idle seconds", "behavior.zero": "Set to 0 to disable.", "behavior.random": "Random pools", "behavior.randomHint": "The Click / Double-click columns are what you trigger yourself; Idle is what it plays on its own. Click a column heading to toggle all.", "behavior.motions": "Motions", "behavior.expressions": "Expressions", "behavior.expressionClick": "Click", "behavior.motionDoubleClick": "Double-click", "behavior.idleActions": "Idle",
    "models.title": "Models", "models.hint": "Drop a Cubism model folder containing a *.model3.json file.", "models.drop": "Drop a model folder here", "models.open": "Open Models Folder in Finder",
    "common.empty": "No available items for this model", "models.empty": "No models installed", "models.hide": "Hide", "models.delete": "Delete", "models.deleteConfirm": "Click Confirm again to delete the model:", "models.deleteAgain": "Confirm", "models.installing": "Installing…", "models.installed": "Installed", "models.switchHint": "", "models.tauriOnly": "Drag-and-drop installation is only available inside Agent Avatar", "models.unrecognized": "could not be recognized.",
    ...Object.fromEntries(SEMANTIC_STATES.map(state => [`state.${state}`, state[0].toUpperCase() + state.slice(1)])),
  },
};
let locale: Language = "zh-CN";
const tr = (key: string): string => TEXT[locale][key] ?? key;

function applyLanguage(next: Language): void {
  locale = next; document.documentElement.lang = next;
  const title = next === "en" ? "Agent Avatar Settings" : "Agent Avatar 设置";
  document.title = title;
  // `document.title` 只改网页标题，**原生窗口的标题栏不跟着变** —— 必须显式 setTitle。
  // `getCurrentWindow()` 在非 Tauri 环境下**同步抛错**，`.catch()` 接不住：不裹 try
  // 的话浏览器里打开设置页会在这里断掉整个 boot（同 bindInstall 的那条注释）。
  try { void getCurrentWindow().setTitle(title).catch(console.error); }
  catch (error) { console.error("setTitle unavailable", error); }
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach(node => { node.textContent = tr(node.dataset.i18n!); });
  document.querySelectorAll<HTMLSelectElement>('[data-list="state-motions"] select').forEach(select => { select.options[0].text = tr("agent.default"); });
}

function bindTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab]"));
  const show = (name: string) => {
    tabs.forEach(tab => { const on = tab.dataset.tab === name; tab.setAttribute("aria-selected", String(on)); tab.tabIndex = on ? 0 : -1; });
    document.querySelectorAll<HTMLElement>("[data-panel]").forEach(panel => { panel.hidden = panel.dataset.panel !== name; });
  };
  tabs.forEach(tab => tab.addEventListener("click", () => show(tab.dataset.tab!)));
  show("general");
}

function bindSlider(act: "scale" | "opacity" | "focus", key: string, fallback: number, toChange: (percent: number) => SettingsChange): void {
  const input = $<HTMLInputElement>(`[data-act="${act}"]`);
  const percent = prefs.read(key, fallback);
  input.value = String(percent);
  setLabel(act, `${percent}%`);
  input.addEventListener("input", () => {
    const value = Number(input.value);
    setLabel(act, `${value}%`);
    // 不在这里落盘：缩放由主窗口改完窗口尺寸后再写，两处都写会打架。
    announce(toChange(value));
  });
}

/** 一个下拉选择：选项、当前值、选中后干什么。 */
function bindSelect<T extends string | number>(
  act: string, options: readonly T[], labelOf: (value: T) => string,
  current: T, onPick: (value: T) => void,
): void {
  const select = $<HTMLSelectElement>(`[data-act="${act}"]`);
  select.innerHTML = options
    .map(value => `<option value="${String(value)}"${value === current ? " selected" : ""}>${labelOf(value)}</option>`)
    .join("");
  select.addEventListener("change", () => {
    const picked = options.find(value => String(value) === select.value);
    if (picked !== undefined) onPick(picked);
  });
}

/** 名单的一列：点击触发的，还是闲置自治的。同一个动作在两种场合的合适程度并不一样。 */
interface PoolColumn {
  storageKey: string;
  initial: string[];
  toChange: (list: string[]) => SettingsChange;
}

/** 一份两列的可勾选清单：左列「点击」、右列「闲置」。 */
function renderChecklist(
  host: HTMLElement, items: { key: string; label: string }[], enabled: [string[], string[]],
  onToggle: (column: 0 | 1, key: string, on: boolean) => void,
): void {
  host.textContent = "";
  if (!items.length) { host.innerHTML = `<div class="empty">${tr("common.empty")}</div>`; return; }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "check-row";
    const name = document.createElement("span");
    name.className = "name"; name.textContent = item.label;
    row.append(name);
    for (const column of [0, 1] as const) {
      const cell = document.createElement("label");
      cell.className = "cell";
      const box = document.createElement("input");
      box.type = "checkbox"; box.checked = enabled[column].includes(item.key);
      box.addEventListener("change", () => onToggle(column, item.key, box.checked));
      cell.append(box);
      row.append(cell);
    }
    host.append(row);
  }
}

/**
 * 语言切换时要重画的动态内容。
 *
 * `applyLanguage` 只更新带 `data-i18n` 的静态节点，而名单是 JS 现生成的 ——
 * 空名单那句「这个模型没有可用项」原来会在切到英文之后原样留在页面上（发布前逐条过文案时看到）。
 */
const redraws: (() => void)[] = [];

function bindPool(
  kind: "motions" | "expressions",
  items: { key: string; label: string }[],
  columns: [PoolColumn, PoolColumn],
): void {
  const enabled: [string[], string[]] = [[...columns[0].initial], [...columns[1].initial]];
  const host = $<HTMLElement>(`[data-list="${kind}"]`);
  const buttons = ([0, 1] as const).map(column =>
    $<HTMLButtonElement>(`[data-act="${kind}-all-${column === 0 ? "click" : "idle"}"]`));

  const commit = (column: 0 | 1) => {
    writePool(columns[column].storageKey, enabled[column]);
    announce(columns[column].toChange(enabled[column]));
    buttons[column].dataset.on = String(enabled[column].length === items.length && items.length > 0);
  };
  const draw = () => renderChecklist(host, items, enabled, (column, key, on) => {
    enabled[column] = on ? [...enabled[column], key] : enabled[column].filter(item => item !== key);
    commit(column);
  });

  for (const column of [0, 1] as const) {
    buttons[column].addEventListener("click", () => {
      enabled[column] = enabled[column].length === items.length ? [] : items.map(item => item.key);
      commit(column); draw();
    });
    commit(column);
  }
  draw();
  redraws.push(draw);
}

function bindStateMotions(dir: string, motions: { key: string; label: string; ref: MotionRef }[]): void {
  const host = $<HTMLElement>('[data-list="state-motions"]');
  const configured = readStateMotions(dir);
  const commit = () => { rememberStateMotions(dir, configured); announce({ stateMotions: { ...configured } }); };
  for (const state of SEMANTIC_STATES) {
    const row = document.createElement("div"); row.className = "state-motion-row";
    const label = document.createElement("label"); label.dataset.i18n = `state.${state}`; label.textContent = tr(`state.${state}`);
    const select = document.createElement("select"); select.dataset.state = state;
    select.append(new Option(tr("agent.default"), ""));
    motions.forEach(item => select.append(new Option(item.label, item.key)));
    const current = configured[state]; select.value = current ? motionKey(current) : "";
    select.addEventListener("change", () => {
      const picked = motions.find(item => item.key === select.value);
      if (picked) configured[state] = picked.ref; else delete configured[state];
      commit();
    });
    row.append(label, select); host.append(row);
  }
}

function updateLocalizedSelects(): void {
  const positions: Record<Language, Record<StatusPosition, string>> = {
    "zh-CN": STATUS_LABELS,
    en: { "top-left": "Top left", "top-right": "Top right", "bottom-left": "Bottom left", "bottom-right": "Bottom right", none: "Hidden" },
  };
  const status = $<HTMLSelectElement>('[data-act="status-position"]');
  for (const option of Array.from(status.options)) option.text = positions[locale][option.value as StatusPosition];
  const quality = $<HTMLSelectElement>('[data-act="quality"]');
  const qualityLabels = locale === "en" ? { 高: "High", 中: "Medium", 低: "Low" } : { 高: "高", 中: "中", 低: "低" };
  for (const option of Array.from(quality.options)) option.text = qualityLabels[option.value as keyof typeof qualityLabels] ?? option.value;
}

/** 拖皮肤文件夹进来安装。用 Tauri 的窗口拖放事件而不是 HTML5 的 —— 只有前者给得到真实路径。 */
type InstalledModel = { dir: string; label: string; model3: string; adapted: boolean };

async function showModels(): Promise<void> {
  const host = $<HTMLElement>('[data-list="models"]');
  const models = await invoke<InstalledModel[]>("list_installed_models").catch(() => []);
  let hidden = readHiddenModels();
  host.textContent = "";
  if (!models.length) { host.innerHTML = `<div class="empty">${tr("models.empty")}</div>`; return; }
  for (const model of models) {
    const row = document.createElement("div"); row.className = "model-row";
    const name = document.createElement("span"); name.className = "model-name"; name.textContent = model.label;
    const hide = document.createElement("label");
    const checkbox = document.createElement("input"); checkbox.type = "checkbox";
    checkbox.checked = hidden.includes(model.dir);
    checkbox.addEventListener("change", () => {
      hidden = checkbox.checked ? [...hidden, model.dir] : hidden.filter(dir => dir !== model.dir);
      writeHiddenModels(hidden); announce({ hiddenModels: [...hidden] });
    });
    hide.append(checkbox, document.createTextNode(tr("models.hide")));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "delete"; remove.textContent = tr("models.delete");
    // 两步确认，不用 `confirm()` —— Tauri 的 webview 不实现它（返回 false），
    // 表现是「点删除没有任何反应」。同 connectors.ts 里的卸载按钮。
    let armed: number | undefined;
    remove.addEventListener("click", () => {
      if (armed === undefined) {
        remove.textContent = tr("models.deleteAgain");
        setLabel("install", `${tr("models.deleteConfirm")} “${model.label}”`);
        armed = window.setTimeout(() => {
          armed = undefined; remove.textContent = tr("models.delete"); setLabel("install", "");
        }, 6000);
        return;
      }
      clearTimeout(armed); armed = undefined; remove.textContent = tr("models.delete"); setLabel("install", "");
      void invoke("delete_model", { dir: model.dir }).then(() => {
        void showModels(); void showIssues();
        announce({ modelDeleted: model.dir });
      }).catch(error => setLabel("install", errorMessage(error, locale)));
    });
    row.append(name, hide, remove); host.append(row);
  }
}

function bindInstall(): void {
  const zone = $<HTMLElement>("#drop");
  const say = (text: string, kind: "" | "ok" | "error" = "") => {
    const status = $<HTMLElement>('[data-label="install"]');
    status.textContent = text; status.className = `status ${kind}`;
  };
  // `getCurrentWebview()` 在非 Tauri 环境下**同步抛错**，`.catch()` 接不住 ——
  // 不裹 try 的话它会把整个 boot 打断，列表和滑块都渲染不出来（实测如此）。
  try {
    void getCurrentWebview().onDragDropEvent(async event => {
      const path = droppedPath(event.payload);
      zone.classList.toggle("over", event.payload.type === "enter" || event.payload.type === "over");
      if (!path) return;
      say(tr("models.installing"));
      try {
        const installed = await invoke<{ dir: string }>("install_model", { path });
        say(`${tr("models.installed")} “${installed.dir}”${tr("models.switchHint")}`, "ok");
        void showIssues(); void showModels();
      } catch (error) {
        say(errorMessage(error, locale), "error");
      }
    }).catch(console.error);
  } catch (error) {
    console.error("drag-drop unavailable", error);
    zone.textContent = tr("models.tauriOnly");
  }

  $('[data-act="open-models"]').addEventListener("click", () => void invoke("open_models_dir").catch(console.error));
}

/** 文件夹里没能变成皮肤的东西。静默失败最难查 —— 压缩包丢进去毫无反应，用户只能来问。 */
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const issueText = (reason: string, rawName: string): string => {
  const name = escapeHtml(rawName);
  if (locale === "en") {
    if (reason === "archive") return `<b>${name}</b> is an archive. Extract it first, then keep the extracted <b>folder</b> here.`;
    if (reason === "no-model3") return `<b>${name}</b> has no <code>*.model3.json</code> within two folder levels.`;
    if (reason === "bad-name") return `<b>${name}</b> must be renamed using only letters, numbers, - or _.`;
  } else {
    if (reason === "archive") return `<b>${name}</b> 是压缩包。请先双击解压，把解压出来的<b>文件夹</b>留在这里。`;
    if (reason === "no-model3") return `<b>${name}</b> 里没找到 <code>*.model3.json</code>（向下找了两层）。`;
    if (reason === "bad-name") return `<b>${name}</b> 的名字不能用作模型名：请改成只含字母、数字、- 或 _。`;
  }
  return `<b>${name}</b> ${tr("models.unrecognized")}`;
};

async function showIssues(): Promise<void> {
  const host = $<HTMLElement>('[data-list="issues"]');
  const issues = await invoke<{ name: string; reason: string }[]>("list_model_issues").catch(() => []);
  host.innerHTML = issues
    .map(item => `<div class="issue">${issueText(item.reason, item.name)}</div>`)
    .join("");
}

/** 接入区块：与首次运行的向导共用同一份实现（见 connectors.ts）。 */
const showConnectors = (): void => renderConnectors($<HTMLElement>('[data-list="connectors"]'), locale);

/** 每一块独立失败：设置页有五组控件，一组坏了不该让其余四组一起消失。 */
function guard(name: string, run: () => void): void {
  try { run(); } catch (error) { console.error(`settings:${name}`, error); }
}

async function boot(): Promise<void> {
  await loadPrefs();  // 同主窗口：配置先就位，后面全是同步读
  locale = language(); applyLanguage(locale); bindTabs();
  guard("language", () => bindSelect<Language>("language", LANGUAGES,
    value => value === "en" ? "English" : "简体中文", locale,
    value => { rememberLanguage(value); applyLanguage(value); updateLocalizedSelects(); void showIssues(); void showModels(); showConnectors(); redraws.forEach(redraw => redraw()); announce({ language: value }); }));
  guard("scale", () => bindSlider("scale", "scale", 100, scalePercent => ({ scalePercent })));
  guard("opacity", () => bindSlider("opacity", "opacity", 100, opacityPercent => ({ opacityPercent })));
  guard("focus", () => bindSlider("focus", "focusPercent", DEFAULT_FOCUS_PERCENT, focusPercent => ({ focusPercent })));
  guard("idle-delay", () => {
    const input = $<HTMLInputElement>('[data-act="idle-delay"]');
    input.value = String(idleDelaySeconds());
    input.addEventListener("change", () => {
      const seconds = Math.max(0, Math.min(600, Math.round(Number(input.value) || 0)));
      input.value = String(seconds);  // 把越界/乱填的值写回去，别让界面显示一个不算数的数
      rememberIdleDelay(seconds);
      announce({ idleDelaySeconds: seconds });
    });
  });

  guard("status-position", () => bindSelect<StatusPosition>(
    "status-position", STATUS_POSITIONS, value => locale === "en"
      ? ({ "top-left": "Top left", "top-right": "Top right", "bottom-left": "Bottom left", "bottom-right": "Bottom right", none: "Hidden" } as const)[value]
      : STATUS_LABELS[value], statusPosition(),
    value => { rememberStatusPosition(value); announce({ statusPosition: value }); }));

  guard("quality", () => {
    const qualities = Object.keys(RENDER_SCALE) as RenderQuality[];
    const stored = quality() as RenderQuality | null;
    bindSelect<RenderQuality>("quality", qualities, value => locale === "en" ? ({ 高: "High", 中: "Medium", 低: "Low" } as const)[value] : value,
      stored && qualities.includes(stored) ? stored : "高",
      value => announce({ quality: value }));  // 落盘由主窗口做，两处都写会打架
  });

  guard("fps", () => bindSelect<number>(
    "fps", FPS_CHOICES, value => `${value} FPS`, prefs.read("fps", 30) === 60 ? 60 : 30,
    value => announce({ fps: value })));

  guard("connectors", showConnectors);
  guard("install", bindInstall);
  void showIssues(); void showModels();

  const dir = currentModelDir();
  let inventory: ModelInventory = { motions: [], expressions: [] };
  try {
    const baseUrl = modelBaseUrl(dir, currentModelSource());
    let model3: string | undefined;
    if (currentModelSource() === "installed") {
      const installed = await invoke<{ dir: string; model3: string; adapted: boolean }[]>("list_installed_models").catch(() => []);
      model3 = installed.find(item => item.dir === dir)?.model3;
    }
    const manifest = await loadManifest({ baseUrl, manifest: "avatar.json", model3 });
    inventory = await loadInventory(baseUrl, manifest.model);
  } catch (error) {
    console.error("inventory unavailable", error);
  }

  const motions = motionRefs(inventory).map((ref: MotionRef) => ({ key: motionKey(ref), label: motionLabel(inventory, ref), ref }));
  const expressions = inventory.expressions.map(name => ({ key: name, label: name }));

  guard("state-motions", () => bindStateMotions(dir, motions));

  guard("motions", () => bindPool("motions", motions, [
    { storageKey: motionPoolKey(dir),
      initial: readPool(motionPoolKey(dir)) ?? defaultEnabledMotions(inventory),
      toChange: enabledMotions => ({ enabledMotions }) },
    // 闲置默认全开（含 Idle 组）：自治就是「自己随便动动」，不该预先排除什么
    { storageKey: idleMotionPoolKey(dir),
      initial: readPool(idleMotionPoolKey(dir)) ?? motions.map(item => item.key),
      toChange: idleMotions => ({ idleMotions }) },
  ]));

  guard("expressions", () => bindPool("expressions", expressions, [
    { storageKey: expressionPoolKey(dir),
      initial: readPool(expressionPoolKey(dir)) ?? defaultEnabledExpressions(inventory),
      toChange: enabledExpressions => ({ enabledExpressions }) },
    { storageKey: idleExpressionPoolKey(dir),
      initial: readPool(idleExpressionPoolKey(dir)) ?? defaultEnabledExpressions(inventory),
      toChange: idleExpressions => ({ idleExpressions }) },
  ]));
}

void boot();
