import { acceleratorFromEvent, actionLabel, isUsableShortcut, listActions, migrateTriggers, type ActionItem } from "./actions";
import "./settings.css";
import { invoke } from "@tauri-apps/api/core";
import { openRawLevelFor } from "./audio-source";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { droppedPath } from "./drop";
import { loadManifest } from "./manifest";
import {
  loadInventory,
  motionKey, motionLabel, motionRefs, type ModelInventory, type MotionRef,
} from "./inventory";
import { FPS_CHOICES, RENDER_SCALE, type RenderQuality } from "./render-quality";
import {
  currentModelDir, DEFAULT_FOCUS_PERCENT, loadPrefs, quality, expressionPoolKey, motionPoolKey, prefs, readPool, writePool,
  aliasMapKey, hasStored, idleActionPoolKey, readStringMap, triggerMapKey, writeStringMap,
  idleDelaySeconds, rememberIdleDelay, rememberStatusPosition, statusPosition, STATUS_LABELS, STATUS_POSITIONS,
  currentModelSource, language, LANGUAGES, modelBaseUrl, readStateMotions, rememberLanguage, rememberStateMotions,
  readHiddenModels, writeHiddenModels, SETTINGS_EVENT, SHORTCUT_STATUS_EVENT, type Language, type SettingsChange, type StatusPosition,
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
    "behavior.lipSync": "口型", "behavior.lipHint": "灵敏度决定多小的声音算「在说话」；张嘴幅度决定嘴张多大。对系统音频、音频文件与 Hermes 三种音源都生效。", "behavior.meterHint": "上面是当前听到的口型强度，竖线是张嘴的门槛。放点声音，把灵敏度拉到柱子能稳定越过竖线为止。", "behavior.sensitivity": "灵敏度", "behavior.amplitude": "张嘴幅度",
    "behavior.idle": "闲置自治", "behavior.idleHint": "无人交互且 Agent 空闲时，让形象自己看四周、播放动作或表情。", "behavior.delay": "静置多少秒后开始", "behavior.zero": "填 0 即关闭。", "behavior.random": "表情与动作", "behavior.randomHint": "「触发」是你亲自触发的方式：单击人物、双击人物，或一个全局快捷键（桌宠没有焦点时也管用）。同一个触发绑多项就在它们之间随机。「闲置」是没人理它时自己播的，点标题可全开或全关。", "behavior.origin": "原名", "behavior.alias": "别名", "behavior.trigger": "触发", "behavior.idleActions": "闲置", "behavior.kindExpression": "表情", "behavior.kindMotion": "动作", "trigger.none": "无", "trigger.click": "单击", "trigger.dblclick": "双击", "trigger.record": "录制快捷键…", "trigger.recording": "按下组合键…（Esc 取消）", "trigger.needModifier": "快捷键要带 Ctrl / Alt / Shift，否则你正常打字也会触发", "trigger.taken": "这个组合已被别的程序占用，换一个",
    "models.title": "模型", "models.hint": "拖入包含 *.model3.json 的 Cubism 模型文件夹。", "models.drop": "拖模型文件夹到此处",
    "common.empty": "这个模型没有可用项", "models.empty": "尚未安装模型", "models.hide": "隐藏", "models.delete": "删除", "models.deleteConfirm": "再点一次「确认删除」就会删除模型：", "models.deleteAgain": "确认删除", "models.installing": "安装中…", "models.installed": "已安装", "models.switchHint": "", "models.tauriOnly": "拖放安装需要在 Agent Avatar 应用内使用", "models.unrecognized": "无法识别。",
    ...Object.fromEntries(SEMANTIC_STATES.map(state => [`state.${state}`, state])),
  },
  en: {
    "tab.general": "General", "tab.video": "Video", "tab.agent": "Agent", "tab.behavior": "Behavior", "tab.models": "Models",
    "general.language": "Language", "general.interfaceLanguage": "Interface language", "general.languageHint": "Language changes apply to this settings window immediately.", "general.statusBar": "Status bar", "general.statusHint": "Show what the agent is doing and place the label where it does not cover the avatar.", "general.position": "Position",
    "video.display": "Display", "video.scale": "Scale", "video.opacity": "Opacity", "video.focus": "Focus crop: show top", "video.focusHint": "Only applies when Focus Mode is enabled from the context menu.", "video.rendering": "Rendering", "video.renderHint": "Lowering quality usually saves more GPU power than lowering frame rate.", "video.quality": "Quality", "video.fps": "Frame rate",
    "agent.connectors": "Connectors", "agent.connectorsHint": "Pick the agent you use and install its connector. Any remaining manual step is shown below.", "agent.mapping": "Agent state and motion", "agent.mappingHint": "Choose a motion for each agent state on the current model. Model default uses the avatar.json mapping.", "agent.default": "Model default",
    "behavior.lipSync": "Lip sync", "behavior.lipHint": "Sensitivity sets how quiet a sound still counts as speech; mouth range sets how wide it opens. Both apply to system audio, audio files and Hermes alike.", "behavior.meterHint": "The bar is how strongly the app hears speech right now; the line is the threshold to open the mouth. Play something and raise sensitivity until the bar clears the line consistently.", "behavior.sensitivity": "Sensitivity", "behavior.amplitude": "Mouth range",
    "behavior.idle": "Idle autonomy", "behavior.idleHint": "Let the avatar look around or play motions and expressions while the agent is idle.", "behavior.delay": "Start after this many idle seconds", "behavior.zero": "Set to 0 to disable.", "behavior.random": "Expressions and motions", "behavior.randomHint": "Trigger is how you set it off yourself: click the character, double-click it, or a global shortcut that works even when the avatar has no focus. Bind several rows to the same trigger and it picks among them at random. Idle is what it plays on its own; click the heading to toggle all.", "behavior.origin": "Name in model", "behavior.alias": "Alias", "behavior.trigger": "Trigger", "behavior.idleActions": "Idle", "behavior.kindExpression": "Expression", "behavior.kindMotion": "Motion", "trigger.none": "None", "trigger.click": "Click", "trigger.dblclick": "Double-click", "trigger.record": "Record shortcut…", "trigger.recording": "Press a combination… (Esc to cancel)", "trigger.needModifier": "A shortcut needs Ctrl / Alt / Shift, or ordinary typing would set it off", "trigger.taken": "That combination is taken by another app — pick a different one",
    "models.title": "Models", "models.hint": "Drop a Cubism model folder containing a *.model3.json file.", "models.drop": "Drop a model folder here",
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

function bindSlider(act: "scale" | "opacity" | "focus" | "lip-sensitivity" | "mouth-amplitude", key: string, fallback: number, toChange: (percent: number) => SettingsChange): void {
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

/**
 * 语言切换时要重画的动态内容。
 *
 * `applyLanguage` 只更新带 `data-i18n` 的静态节点，而名单是 JS 现生成的 ——
 * 空名单那句「这个模型没有可用项」原来会在切到英文之后原样留在页面上（发布前逐条过文案时看到）。
 */
const redraws: (() => void)[] = [];

/**
 * 表情与动作合成的那张表：原名 | 别名 | 触发 | 闲置。
 *
 * 「触发」是个下拉：无 / 单击 / 双击 / 录制快捷键…。选最后一项就地进入录制状态，
 * **不弹窗** —— 弹窗要抢焦点，而录制正好是在抢按键，两者会打架；为一个组合键开一个窗口也太重。
 */
function bindActions(dir: string, items: readonly ActionItem[], idleDefault: readonly string[]): void {
  const host = $<HTMLElement>('[data-list="actions"]');
  const idleAll = $<HTMLButtonElement>('[data-act="actions-all-idle"]');
  const triggers = readStringMap(triggerMapKey(dir));
  const aliases = readStringMap(aliasMapKey(dir));
  let idle = readPool(idleActionPoolKey(dir)) ?? [...idleDefault];

  // 从 1.0 的两个名单迁移一次。判据是「有没有存过」而不是「存的是不是空的」——
  // 用户把所有触发都清空之后，不能下次打开设置又被旧名单迁移回来。
  if (!hasStored(triggerMapKey(dir))) {
    Object.assign(triggers, migrateTriggers(items,
      readPool(expressionPoolKey(dir)) ?? [], readPool(motionPoolKey(dir)) ?? []));
    writeStringMap(triggerMapKey(dir), triggers);
  }

  const commitTriggers = () => { writeStringMap(triggerMapKey(dir), triggers); announce({ triggers: { ...triggers } }); };
  const commitAliases = () => { writeStringMap(aliasMapKey(dir), aliases); announce({ aliases: { ...aliases } }); };
  const commitIdle = () => {
    writePool(idleActionPoolKey(dir), idle);
    announce({ idleActions: [...idle] });
    idleAll.dataset.on = String(idle.length === items.length && items.length > 0);
  };

  const draw = () => {
    host.textContent = "";
    if (!items.length) { host.innerHTML = `<div class="empty">${tr("common.empty")}</div>`; return; }
    for (const item of items) host.append(actionRow(item));
  };

  function actionRow(item: ActionItem): HTMLElement {
    const row = document.createElement("div");
    row.className = "action-row";
    row.dataset.kind = item.kind;

    const origin = document.createElement("span");
    origin.className = "origin";
    origin.textContent = item.origin;
    // 合成一张表之后，这里是唯一能看出这行是表情还是动作的地方（左边那道色条同理）
    origin.title = `${tr(item.kind === "motion" ? "behavior.kindMotion" : "behavior.kindExpression")} · ${item.origin}`;

    const alias = document.createElement("input");
    alias.className = "alias"; alias.type = "text"; alias.maxLength = 40;
    alias.value = aliases[item.key] ?? "";
    // 占位符显示「不填会用什么」：作者起的名字，或者原名
    alias.placeholder = item.authored || item.origin;
    alias.addEventListener("change", () => {
      const value = alias.value.trim();
      if (value) aliases[item.key] = value; else delete aliases[item.key];
      commitAliases();
    });

    const trigger = document.createElement("select");
    trigger.className = "trigger";
    fillTriggerOptions(trigger, triggers[item.key]);
    trigger.addEventListener("change", () => {
      if (trigger.value === RECORD) { void recordInto(item, trigger, row); return; }
      if (trigger.value) triggers[item.key] = trigger.value; else delete triggers[item.key];
      clearTriggerNote(row); row.dataset.failed = "false";
      commitTriggers();
    });

    const idleCell = document.createElement("label");
    idleCell.className = "cell";
    const box = document.createElement("input");
    box.type = "checkbox"; box.checked = idle.includes(item.key);
    box.addEventListener("change", () => {
      idle = box.checked ? [...idle, item.key] : idle.filter(key => key !== item.key);
      commitIdle();
    });
    idleCell.append(box);

    row.append(origin, alias, trigger, idleCell);
    return row;
  }

  /**
   * 主窗口报回来「哪些组合没注册上」。**必须显式标出来** —— 被别的程序占了是常事，
   * 静默失效的表现是「设了没反应」，用户无从判断是自己设错了还是程序坏了。
   */
  void listen<{ failed?: string[] }>(SHORTCUT_STATUS_EVENT, event => {
    const failed = new Set(event.payload?.failed ?? []);
    items.forEach((item, index) => {
      const row = host.children[index] as HTMLElement | undefined;
      if (!row) return;
      const trigger = triggers[item.key];
      const broken = Boolean(trigger) && failed.has(trigger);
      row.dataset.failed = String(broken);
      if (broken) showTriggerNote(row, tr("trigger.taken")); else clearTriggerNote(row);
    });
  }).catch(console.error);

  idleAll.addEventListener("click", () => {
    idle = idle.length === items.length ? [] : items.map(item => item.key);
    commitIdle(); draw();
  });
  commitIdle();
  draw();
  redraws.push(draw);

  /**
   * 就地录制一个组合键。
   *
   * 录制期间必须让主窗口**暂时反注册**它已有的全局快捷键：不然你想录 `Ctrl+X`，
   * 按下去会先把已经绑在 `Ctrl+X` 上的那一项播了，而这个按键根本传不到这里来。
   */
  async function recordInto(item: ActionItem, select: HTMLSelectElement, row: HTMLElement): Promise<void> {
    const previous = triggers[item.key] ?? "";
    select.hidden = true;
    const pad = document.createElement("button");
    pad.type = "button"; pad.className = "trigger recording";
    pad.textContent = tr("trigger.recording");
    row.insertBefore(pad, select);
    pad.focus();
    announce({ shortcutsSuspended: true });

    const finish = (value: string | null) => {
      window.removeEventListener("keydown", onKey, true);
      pad.remove();
      select.hidden = false;
      if (value !== null) {
        if (value) triggers[item.key] = value; else delete triggers[item.key];
        writeStringMap(triggerMapKey(dir), triggers);
      }
      // 「不再暂停」和新的绑定一次发完：分两条广播会让主窗口连着跑两遍注册
      announce({ shortcutsSuspended: false, triggers: { ...triggers } });
      fillTriggerOptions(select, triggers[item.key]);
      select.focus();
    };

    const onKey = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") { finish(previous); return; }   // 取消 = 保持原样
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return;                                    // 还只按着修饰键
      if (!isUsableShortcut(accelerator)) { showTriggerNote(row, tr("trigger.needModifier")); return; }
      clearTriggerNote(row);
      finish(accelerator);
    };
    window.addEventListener("keydown", onKey, true);
  }
}

const RECORD = "__record__";

/** 下拉里的固定项，外加当前那个快捷键（如果有）。 */
function fillTriggerOptions(select: HTMLSelectElement, current: string | undefined): void {
  select.textContent = "";
  select.append(new Option(tr("trigger.none"), ""));
  select.append(new Option(tr("trigger.click"), "click"));
  select.append(new Option(tr("trigger.dblclick"), "dblclick"));
  if (current && current !== "click" && current !== "dblclick") select.append(new Option(current, current));
  select.append(new Option(tr("trigger.record"), RECORD));
  select.value = current ?? "";
}

/** 失败或不合法的原因贴在那一行下面。 */
function showTriggerNote(row: HTMLElement, text: string): void {
  let note = row.querySelector<HTMLElement>(".trigger-note");
  if (!note) { note = document.createElement("p"); note.className = "trigger-note"; row.append(note); }
  note.textContent = text;
}

function clearTriggerNote(row: HTMLElement): void { row.querySelector(".trigger-note")?.remove(); }

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
type InstalledModel = { dir: string; label: string; model3: string; adapted: boolean; displayNames?: Record<string, string> };

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


/**
 * 口型电平条。柱子 = 主窗口实时送来的口型强度，竖线 = 张嘴门槛（`OPEN_AT`）。
 *
 * 为什么要它：调灵敏度之前，用户只能「放音乐 → 盯着人物 → 猜」，而「嘴不动」至少有
 * 五个互不相同的原因（音量太低、选错音源、DRM 内容抓不到、灵敏度不够、模型没声明口型参数）。
 * 有了柱子和线，前四个当场就能排掉。
 *
 * 只在本页开着时让主窗口发数据 —— 见 main.ts 的 forwardLipLevel。
 */
function bindLipMeter(): void {
  const meter = document.querySelector<HTMLElement>('[data-act="lip-meter"]');
  if (!meter) return;
  const fill = meter.querySelector<HTMLElement>(".lip-fill")!;
  const mark = meter.querySelector<HTMLElement>(".lip-mark")!;
  // 原始音量跨三个数量级（静音约 0.0001，响的音频到 0.24），线性刻度下全挤在最左边，
  // 什么也看不出来。按分贝铺开，-70dB 到 0dB。
  const MIN_DB = -70;
  const place = (raw: number): number => {
    const db = 20 * Math.log10(Math.max(1e-6, raw));
    return Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB));
  };
  const moveMark = () => {
    const percent = Number($<HTMLInputElement>('[data-act="lip-sensitivity"]').value);
    mark.style.left = `${place(openRawLevelFor(percent)) * 100}%`;
  };
  moveMark();
  $<HTMLInputElement>('[data-act="lip-sensitivity"]').addEventListener("input", moveMark);
  try {
    void emit("lip-meter:watch", true);
    void listen<{ raw: number; open: boolean }>("lip-meter:level", event => {
      const { raw = 0, open = false } = event.payload ?? {};
      fill.style.width = `${place(raw) * 100}%`;
      meter.classList.toggle("open", open);
    });
    // 关窗时收手，别让主窗口白发事件
    addEventListener("beforeunload", () => { void emit("lip-meter:watch", false); });
  } catch (error) {
    console.error("lip meter unavailable", error);
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
  guard("lip-meter", () => bindLipMeter());
  guard("lip-sensitivity", () => bindSlider("lip-sensitivity", "lipSensitivity", 50, lipSensitivityPercent => ({ lipSensitivityPercent })));
  guard("mouth-amplitude", () => bindSlider("mouth-amplitude", "mouthAmplitude", 100, mouthAmplitudePercent => ({ mouthAmplitudePercent })));
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
  // 作者给零件起的名字，导入时由清洗器从 cdi3 / vtube.json 里读好。别名那一列拿它当默认值 ——
  // 大多数模型作者其实起过名（boy8 起全了 20 个），用户一个字都不用填。
  let displayNames: Record<string, string> = {};
  try {
    const baseUrl = modelBaseUrl(dir, currentModelSource());
    let model3: string | undefined;
    if (currentModelSource() === "installed") {
      const installed = await invoke<InstalledModel[]>("list_installed_models").catch(() => []);
      const entry = installed.find(item => item.dir === dir);
      model3 = entry?.model3;
      displayNames = entry?.displayNames ?? {};
    }
    const manifest = await loadManifest({ baseUrl, manifest: "avatar.json", model3 });
    inventory = await loadInventory(baseUrl, manifest.model);
  } catch (error) {
    console.error("inventory unavailable", error);
  }

  const motions = motionRefs(inventory).map((ref: MotionRef) => ({ key: motionKey(ref), label: motionLabel(inventory, ref), ref }));
  const actions = listActions(inventory, displayNames);
  // 闲置默认全开：自治就是「自己随便动动」，不该预先排除什么。
  // 触发那一列不给默认值 —— 从旧版本升上来的走迁移，全新模型让用户自己挑。
  const idleDefault = actions.map(item => item.key);

  guard("state-motions", () => bindStateMotions(dir, motions));

  guard("actions", () => bindActions(dir, actions, idleDefault));
}

void boot();
