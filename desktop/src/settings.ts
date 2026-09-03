import { acceleratorFromEvent, actionLabel, groupActions, isUsableShortcut, listActions, defaultTriggers, migrateTriggers, MOTION_GROUP, type ActionItem, type SwitchTable } from "./actions";
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
  aliasMapKey, hasStored, heldActionPoolKey, idleActionPoolKey, readStringMap, triggerMapKey, writeStringMap,
  idleDelaySeconds, rememberIdleDelay, rememberStatusPosition, statusPosition, STATUS_LABELS, STATUS_POSITIONS,
  currentModelSource, language, LANGUAGES, modelBaseUrl, readStateMotions, rememberLanguage, rememberStateMotions,
  readHiddenModels, writeHiddenModels, readUpdateCheck, writeUpdateCheck,
  readLastUpdateCheck, writeLastUpdateCheck, SETTINGS_EVENT, SHORTCUT_STATUS_EVENT, type Language, type SettingsChange, type StatusPosition,
} from "./prefs";
import { SEMANTIC_STATES, type SemanticState } from "./types";
import { renderConnectors } from "./connectors";
import { checkForUpdate, shouldCheck } from "./updates";
import { errorMessage } from "./errors";

/** 改动即时广播给主窗口；config.json 只负责持久化，不负责生效。 */
const announce = (change: SettingsChange) => void emit(SETTINGS_EVENT, change).catch(console.error);

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const setLabel = (name: string, text: string) => { $(`[data-label="${name}"]`).textContent = text; };

const TEXT: Record<Language, Record<string, string>> = {
  "zh-CN": {
    "tab.general": "通用", "tab.video": "视频", "tab.agent": "Agent", "tab.behavior": "行为", "tab.models": "模型",
    "general.language": "语言", "general.interfaceLanguage": "界面语言", "general.languageHint": "语言切换会立即应用到设置窗口。", "general.statusBar": "状态栏", "general.statusHint": "显示 Agent 当前在做什么，并可调整到不遮挡模型的位置。", "general.position": "位置",
    "general.about": "关于", "general.updateCheck": "自动检查更新", "general.updateHint": "只查一个版本号，不会下载或安装任何东西。查不到时（离线、代理、网络限制）不会有任何提示。", "general.checkNow": "检查更新", "general.checking": "查询中…", "general.upToDate": "已是最新版本。", "general.unreachable": "这会儿查不到（离线或网络受限），不影响使用。", "general.newVersion": "有新版本 {version}", "general.applyUpdate": "去下载",
    "video.display": "显示", "video.scale": "缩放", "video.opacity": "透明度", "video.focus": "聚焦范围：显示顶部", "video.focusHint": "仅在右键菜单启用聚焦模式时生效。", "video.rendering": "渲染", "video.renderHint": "降低画质通常比降低帧率更省 GPU。", "video.quality": "画质", "video.fps": "帧率",
    "agent.connectors": "接入", "agent.connectorsHint": "选一个你在用的 agent，点「安装」就行。连接器和它需要的运行环境都在这个应用里，不联网、不下载；装完如果还需要你做点什么，会显示在下面。", "agent.mapping": "状态与动作", "agent.mappingHint": "为当前模型的每个 Agent 状态选择动作。选择“模型默认”会使用 avatar.json 的映射。", "agent.default": "模型默认",
    "agent.removeAll": "移除所有连接器", "agent.removeAllHint": "删除本应用之前先点一下：它会把五家里的登记收回来。不这么做的话，那些登记会留在你的 agent 里，指向一个已经不存在的程序。",
    "agent.removeAgain": "确认移除", "agent.removeConfirm": "再点一次「确认移除」，会把五家里的登记全部收回。",
    "agent.removing": "正在移除…", "agent.removedNone": "本来就没有装。", "agent.removedSome": "已移除：{list}", "agent.removeFailed": "有几家没成功：{list}",
    "behavior.lipSync": "口型", "behavior.lipHint": "灵敏度决定多小的声音算「在说话」；张嘴幅度决定嘴张多大。对系统音频、音频文件与 Hermes 三种音源都生效。", "behavior.meterHint": "上面是当前听到的口型强度，竖线是张嘴的门槛。放点声音，把灵敏度拉到柱子能稳定越过竖线为止。", "behavior.sensitivity": "灵敏度", "behavior.amplitude": "张嘴幅度",
    "behavior.idle": "闲置自治", "behavior.idleHint": "无人交互且 Agent 空闲时，让形象自己看四周、播放动作或表情。", "behavior.delay": "静置多少秒后开始", "behavior.zero": "填 0 即关闭。", "behavior.random": "表情与动作", "behavior.randomHint": "「触发」是你亲自触发的方式：单击人物、双击人物，或一个全局快捷键（桌宠没有焦点时也管用）。同一个触发绑多项就在它们之间随机。「常驻」勾上就一直保持，可以同时勾多个（戴着猫耳 + 拿着饮料 + 生气）；只有那种「只改一个参数」的项能常驻。「闲置」是没人理它时自己播的，点标题可全开或全关。", "behavior.origin": "原名", "behavior.alias": "别名", "behavior.trigger": "触发", "behavior.hold": "常驻", "behavior.idleActions": "闲置", "behavior.groupOther": "其他", "behavior.groupMotion": "动作（播放一次）", "behavior.holdOnlySwitch": "这一项要同时改多个参数，做不到常驻 —— 它一次只能显示一个", "behavior.holdOnlyMotion": "动作是播一次就结束的，没有「常驻」；想让它一直循环，用「闲置」那一列", "behavior.kindExpression": "表情", "behavior.kindMotion": "动作", "trigger.none": "无", "trigger.click": "单击", "trigger.dblclick": "双击", "trigger.record": "录制快捷键…", "trigger.recording": "按下组合键…（Esc 取消）", "trigger.needModifier": "快捷键要带 Ctrl / Alt / Shift，否则你正常打字也会触发", "trigger.taken": "这个组合已被别的程序占用，换一个",
    "models.title": "模型", "models.hint": "拖入包含 *.model3.json 的 Cubism 模型文件夹。", "models.drop": "拖模型文件夹到此处",
    "common.empty": "这个模型没有可用项", "models.empty": "尚未安装模型", "models.hide": "隐藏", "models.delete": "删除", "models.deleteConfirm": "再点一次「确认删除」就会删除模型：", "models.deleteAgain": "确认删除", "models.installing": "安装中…", "models.installed": "已安装", "models.switchHint": "", "models.tauriOnly": "拖放安装需要在 Agent Avatar 应用内使用", "models.unrecognized": "无法识别。",
    ...Object.fromEntries(SEMANTIC_STATES.map(state => [`state.${state}`, state])),
  },
  en: {
    "tab.general": "General", "tab.video": "Video", "tab.agent": "Agent", "tab.behavior": "Behavior", "tab.models": "Models",
    "general.language": "Language", "general.interfaceLanguage": "Interface language", "general.languageHint": "Language changes apply to this settings window immediately.", "general.statusBar": "Status bar", "general.statusHint": "Show what the agent is doing and place the label where it does not cover the avatar.", "general.position": "Position",
    "general.about": "About", "general.updateCheck": "Check for updates automatically", "general.updateHint": "It reads a version number and nothing else — no download, no install. If it cannot reach the network, it says nothing.", "general.checkNow": "Check for updates", "general.checking": "Checking…", "general.upToDate": "You are on the latest version.", "general.unreachable": "Can't reach it right now (offline or restricted). Nothing is affected.", "general.newVersion": "Version {version} is available", "general.applyUpdate": "Download",
    "video.display": "Display", "video.scale": "Scale", "video.opacity": "Opacity", "video.focus": "Focus crop: show top", "video.focusHint": "Only applies when Focus Mode is enabled from the context menu.", "video.rendering": "Rendering", "video.renderHint": "Lowering quality usually saves more GPU power than lowering frame rate.", "video.quality": "Quality", "video.fps": "Frame rate",
    "agent.connectors": "Connectors", "agent.connectorsHint": "Pick the agent you use and press Install. The connector and the runtime it needs are inside this app — nothing is downloaded. Any remaining manual step is shown below.", "agent.mapping": "Agent state and motion", "agent.mappingHint": "Choose a motion for each agent state on the current model. Model default uses the avatar.json mapping.", "agent.default": "Model default",
    "agent.removeAll": "Remove all connectors", "agent.removeAllHint": "Press this before deleting the app: it takes back the registrations in all five harnesses. Otherwise they stay in your agents, pointing at a program that no longer exists.",
    "agent.removeAgain": "Confirm removal", "agent.removeConfirm": "Press \"Confirm removal\" again to take back the registrations in all five harnesses.",
    "agent.removing": "Removing…", "agent.removedNone": "None were installed.", "agent.removedSome": "Removed: {list}", "agent.removeFailed": "Some could not be removed: {list}",
    "behavior.lipSync": "Lip sync", "behavior.lipHint": "Sensitivity sets how quiet a sound still counts as speech; mouth range sets how wide it opens. Both apply to system audio, audio files and Hermes alike.", "behavior.meterHint": "The bar is how strongly the app hears speech right now; the line is the threshold to open the mouth. Play something and raise sensitivity until the bar clears the line consistently.", "behavior.sensitivity": "Sensitivity", "behavior.amplitude": "Mouth range",
    "behavior.idle": "Idle autonomy", "behavior.idleHint": "Let the avatar look around or play motions and expressions while the agent is idle.", "behavior.delay": "Start after this many idle seconds", "behavior.zero": "Set to 0 to disable.", "behavior.random": "Expressions and motions", "behavior.randomHint": "Trigger is how you set it off yourself: click the character, double-click it, or a global shortcut that works even when the avatar has no focus. Bind several rows to the same trigger and it picks among them at random. Keep on holds an item indefinitely, and several can be on at once (cat ears + a drink + angry); only entries that change a single parameter can be held. Idle is what it plays on its own; click the heading to toggle all.", "behavior.origin": "Name in model", "behavior.alias": "Alias", "behavior.trigger": "Trigger", "behavior.hold": "Keep on", "behavior.idleActions": "Idle", "behavior.groupOther": "Other", "behavior.groupMotion": "Motions (play once)", "behavior.holdOnlySwitch": "This one changes several parameters at once, so it cannot stay on — only one of its kind shows at a time", "behavior.holdOnlyMotion": "A motion plays once and ends, so there is nothing to keep on; use the Idle column to have it come back", "behavior.kindExpression": "Expression", "behavior.kindMotion": "Motion", "trigger.none": "None", "trigger.click": "Click", "trigger.dblclick": "Double-click", "trigger.record": "Record shortcut…", "trigger.recording": "Press a combination… (Esc to cancel)", "trigger.needModifier": "A shortcut needs Ctrl / Alt / Shift, or ordinary typing would set it off", "trigger.taken": "That combination is taken by another app — pick a different one",
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
  // 常驻默认全关：勾上是「一直保持」，不该有任何一项是我们替用户开的
  let held = readPool(heldActionPoolKey(dir)) ?? [];

  // 从 1.0 的两个名单迁移一次。判据是「有没有存过」而不是「存的是不是空的」——
  // 用户把所有触发都清空之后，不能下次打开设置又被旧名单迁移回来。
  if (!hasStored(triggerMapKey(dir))) {
    const hadOldPools = hasStored(expressionPoolKey(dir)) || hasStored(motionPoolKey(dir));
    Object.assign(triggers, hadOldPools
      ? migrateTriggers(items, readPool(expressionPoolKey(dir)) ?? [], readPool(motionPoolKey(dir)) ?? [])
      : defaultTriggers(items));
    writeStringMap(triggerMapKey(dir), triggers);
  }

  const commitTriggers = () => { writeStringMap(triggerMapKey(dir), triggers); announce({ triggers: { ...triggers } }); };
  const commitAliases = () => { writeStringMap(aliasMapKey(dir), aliases); announce({ aliases: { ...aliases } }); };
  const commitHeld = () => { writePool(heldActionPoolKey(dir), held); announce({ heldActions: [...held] }); };
  const commitIdle = () => {
    writePool(idleActionPoolKey(dir), idle);
    announce({ idleActions: [...idle] });
    idleAll.dataset.on = String(idle.length === items.length && items.length > 0);
  };

  const draw = () => {
    host.textContent = "";
    if (!items.length) { host.innerHTML = `<div class="empty">${tr("common.empty")}</div>`; return; }
    // 按作者在 cdi3 里的分类分块。boy8 会得到「隐藏 / 表情 / 动作」，CandyBoy 只有一块 ——
    // 那就是作者没分类，照实显示，不凭空造分类。
    for (const block of groupActions(items)) {
      const heading = document.createElement("h3");
      heading.className = "action-group";
      heading.textContent = block.group === MOTION_GROUP ? tr("behavior.groupMotion") : block.group ?? tr("behavior.groupOther");
      host.append(heading);
      for (const item of block.items) host.append(actionRow(item));
    }
  };

  function actionRow(item: ActionItem): HTMLElement {
    const row = document.createElement("div");
    row.className = "action-row";
    row.dataset.kind = item.kind;
    row.dataset.key = item.key;

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

    // 常驻只对「单参数开关」开放。多参数的是一整张脸，走表情管理器一次只能挂一个；
    // 动作是时间性的，播完就结束。两种都显示成 ─ 并说明原因，而不是给个点不动的复选框。
    const holdCell = document.createElement("label");
    holdCell.className = "cell";
    if (item.hold) {
      const holdBox = document.createElement("input");
      holdBox.type = "checkbox"; holdBox.checked = held.includes(item.key);
      holdBox.addEventListener("change", () => {
        held = holdBox.checked ? [...held, item.key] : held.filter(key => key !== item.key);
        commitHeld();
      });
      holdCell.append(holdBox);
    } else {
      holdCell.textContent = "─";
      holdCell.className = "cell muted";
      holdCell.title = item.kind === "motion" ? tr("behavior.holdOnlyMotion") : tr("behavior.holdOnlySwitch");
    }

    const idleCell = document.createElement("label");
    idleCell.className = "cell";
    const box = document.createElement("input");
    box.type = "checkbox"; box.checked = idle.includes(item.key);
    box.addEventListener("change", () => {
      idle = box.checked ? [...idle, item.key] : idle.filter(key => key !== item.key);
      commitIdle();
    });
    idleCell.append(box);

    row.append(origin, alias, trigger, holdCell, idleCell);
    return row;
  }

  /**
   * 主窗口报回来「哪些组合没注册上」。**必须显式标出来** —— 被别的程序占了是常事，
   * 静默失效的表现是「设了没反应」，用户无从判断是自己设错了还是程序坏了。
   */
  void listen<{ failed?: string[] }>(SHORTCUT_STATUS_EVENT, event => {
    const failed = new Set(event.payload?.failed ?? []);
    // 按 key 找行，不用序号：分组之后表里还夹着组标题，序号和 items 对不上了
    for (const item of items) {
      const row = host.querySelector<HTMLElement>(`.action-row[data-key="${CSS.escape(item.key)}"]`);
      if (!row) continue;
      const trigger = triggers[item.key];
      const broken = Boolean(trigger) && failed.has(trigger);
      row.dataset.failed = String(broken);
      if (broken) showTriggerNote(row, tr("trigger.taken")); else clearTriggerNote(row);
    }
  }).catch(console.error);

  idleAll.addEventListener("click", () => {
    idle = idle.length === items.length ? [] : items.map(item => item.key);
    commitIdle(); draw();
  });
  commitHeld();
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
type InstalledModel = { dir: string; label: string; model3: string; adapted: boolean; displayNames?: Record<string, string>; switches?: SwitchTable };

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
/**
 * 「关于」：版本号，和那个**联网查版本号**的开关。
 *
 * 两个版本号都要显示，因为它们回答不同的问题：app 的是报 bug 时会贴的那个；connector 的是
 * 「五家 harness 里现在跑的观察者是哪一版」。打包之后它们一起发布，但仍不是同一个数字。
 *
 * 🔴 **查不到就什么都不说**（自动那次）。离线、公司代理、GitHub 在某些网络下不可达 ——
 * 这些都不是用户做错了什么，界面上出现一条像 bug 的红字只会让他去查一个不存在的问题。
 * 手动点「现在检查」时才把「查不到」讲出来，因为那时候他在等一个回答。
 */
const showAbout = (): void => {
  const line = $<HTMLElement>("[data-version=\"app\"]");
  const box = $<HTMLInputElement>('[data-act="update-check"]');
  const check = $<HTMLButtonElement>('[data-act="check-update"]');
  const row = $<HTMLElement>('[data-row="update"]');
  const status = $<HTMLElement>('[data-label="update-status"]');
  const apply = $<HTMLButtonElement>('[data-act="apply-update"]');

  /**
   * 有新版本时才把那一行显示出来。
   *
   * 🔴 **没有更新的时候这一行根本不存在** —— 常驻一条「已是最新」等于每次打开设置都提醒
   * 用户想一遍「我要不要更新」，而答案永远是不用。查不到时同理：离线、公司代理、GitHub 在
   * 某些网络下不可达都不是用户做错了什么，一条像 bug 的红字只会让他去查一个不存在的问题。
   */
  let release = "";
  const showUpdate = (latest: string | null, url?: string) => {
    row.hidden = !latest;
    if (!latest) return;
    status.textContent = tr("general.newVersion").replace("{version}", latest);
    release = url ?? "";
    apply.hidden = !release;
  };

  let version = "";
  showUpdate(null);
  void invoke<{ app?: string; connector?: string | null }>("app_versions").then(versions => {
    version = versions.app ?? "";
    // 🔴 **只显示一个版本号。** 打包之后用户不可能碰到 app 与 connector 版本不一致 ——
    // reconcile 会自动对齐，对不齐时连接器那一行会直接说「升级后还没重新连上」。
    // 两个数字对用户就是纯理解成本。connector 那个仍然有用（报 bug、查状态文件格式），
    // 所以挂在悬停提示里：需要的人看得到，其余人看不见。
    line.textContent = `Agent Avatar ${version}`;
    line.title = versions.connector ? `connector ${versions.connector}` : "";
    return version;
  }).then(current => {
    // 自动检查：一天最多一次，而且开关关掉时一次都不发
    if (!current || !shouldCheck(readUpdateCheck(), readLastUpdateCheck())) return;
    writeLastUpdateCheck(Date.now());
    return checkForUpdate(current).then(info => {
      if (info.newer) showUpdate(info.latest, info.url);
    });
  }).catch(() => undefined);

  box.checked = readUpdateCheck();
  box.onchange = () => { writeUpdateCheck(box.checked); };

  check.onclick = () => {
    check.disabled = true;
    const previous = check.textContent;
    check.textContent = tr("general.checking");
    void checkForUpdate(version).then(info => {
      if (info.newer) return showUpdate(info.latest, info.url);
      showUpdate(null);
      // 手动查的时候必须给个回答 —— 他正在等，沉默会被读成「已是最新」。
      // 「查不到」和「已是最新」要分开说：后者是个断言，而查不到时我们其实什么都不知道。
      status.textContent = tr(info.latest ? "general.upToDate" : "general.unreachable");
      row.hidden = false;
      apply.hidden = true;
    }).finally(() => { check.disabled = false; check.textContent = previous; });
  };

  /**
   * 现在只打开发布页，**不下载、不安装**。
   *
   * 🔴 自动安装本身在代码里不难（Tauri 的 updater 插件），难的是它依赖的那条发布链：
   * 每个产物要用一把**你自己保管的**更新密钥签名、要有 `latest.json` 清单、而且
   * **操作系统层面的签名和公证是另一件事** —— macOS 上自动替换掉的 `.app` 没有公证的话
   * Gatekeeper 会拒绝启动，也就是「点了更新，然后打不开了」。
   *
   * 那条链铺好之后（为了正常分发本来也躲不掉），把这里换成 `downloadAndInstall` 就行，
   * 界面不用动 —— 这个按钮的位置和语义已经是为它留的。
   */
  apply.onclick = () => {
    if (release) void invoke("open_in_browser", { url: release }).catch(console.error);
  };
};

const showConnectors = (): void => {
  renderConnectors($<HTMLElement>('[data-list="connectors"]'), locale);

  /**
   * 一次把五家里的登记全收回来。
   *
   * 🔴 **删掉这个 app 不会带走它们。** 五家的配置里仍然登记着 agent-avatar，而那些 hook
   * 指向一个已经不存在的解释器 —— 留在别人应用里的垃圾，而用户没有理由知道去哪清。
   * 一家一家点五次也行，但没人会记得，所以给一个入口。
   */
  const button = $<HTMLButtonElement>('[data-act="remove-all-connectors"]');
  const said = $<HTMLElement>('[data-label="remove-all"]');

  // 🔴 **两步确认。** 这个按钮一下改五个应用的配置，而它就在一列普通按钮中间 ——
  // 误点的代价是「所有 agent 的形象都不动了」，而恢复要一家一家重装。
  //
  // 不用 `confirm()`：Tauri 的 webview 不实现它，**静默返回 false**，表现是「点了没反应」
  // （实机撞到过，有测试盯着）。同删模型那处，六秒后自动解除待确认状态。
  let armed: number | undefined;
  const disarm = () => {
    if (armed !== undefined) clearTimeout(armed);
    armed = undefined;
    button.textContent = tr("agent.removeAll");
  };
  button.onclick = () => {
    if (armed === undefined) {
      button.textContent = tr("agent.removeAgain");
      said.textContent = tr("agent.removeConfirm");
      armed = window.setTimeout(() => { disarm(); said.textContent = ""; }, 6000);
      return;
    }
    disarm();
    button.disabled = true;
    said.textContent = tr("agent.removing");
    void invoke<{ removed?: string[]; failed?: { harness: string }[] }>("remove_all_connectors")
      .then(report => {
        const removed = report.removed ?? [];
        const failed = (report.failed ?? []).map(item => item.harness);
        said.textContent = failed.length
          ? tr("agent.removeFailed").replace("{list}", failed.join("、"))
          : removed.length
            ? tr("agent.removedSome").replace("{list}", removed.join("、"))
            : tr("agent.removedNone");
        showConnectors();                       // 列表要跟着变，否则它还写着「已连通」
      })
      .catch((error: unknown) => { said.textContent = errorMessage(error, locale); })
      .finally(() => { button.disabled = false; });
  };
};

/** 每一块独立失败：设置页有五组控件，一组坏了不该让其余四组一起消失。 */
function guard(name: string, run: () => void): void {
  try { run(); } catch (error) { console.error(`settings:${name}`, error); }
}

async function boot(): Promise<void> {
  await loadPrefs();  // 同主窗口：配置先就位，后面全是同步读
  locale = language(); applyLanguage(locale); bindTabs();
  guard("language", () => bindSelect<Language>("language", LANGUAGES,
    value => value === "en" ? "English" : "简体中文", locale,
    value => { rememberLanguage(value); applyLanguage(value); updateLocalizedSelects(); void showIssues(); void showModels(); showConnectors(); showAbout(); redraws.forEach(redraw => redraw()); announce({ language: value }); }));
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
  guard("about", showAbout);
  guard("install", bindInstall);
  void showIssues(); void showModels();

  const dir = currentModelDir();
  let inventory: ModelInventory = { motions: [], expressions: [] };
  // 作者给零件起的名字，导入时由清洗器从 cdi3 / vtube.json 里读好。别名那一列拿它当默认值 ——
  // 大多数模型作者其实起过名（boy8 起全了 20 个），用户一个字都不用填。
  let displayNames: Record<string, string> = {};
  // 哪些项是单参数开关（能常驻），以及作者把它归在哪一组
  let switches: SwitchTable = {};
  try {
    const baseUrl = modelBaseUrl(dir, currentModelSource());
    let model3: string | undefined;
    if (currentModelSource() === "installed") {
      const installed = await invoke<InstalledModel[]>("list_installed_models").catch(() => []);
      const entry = installed.find(item => item.dir === dir);
      model3 = entry?.model3;
      displayNames = entry?.displayNames ?? {};
      switches = entry?.switches ?? {};
    }
    const manifest = await loadManifest({ baseUrl, manifest: "avatar.json", model3 });
    inventory = await loadInventory(baseUrl, manifest.model);
  } catch (error) {
    console.error("inventory unavailable", error);
  }

  const motions = motionRefs(inventory).map((ref: MotionRef) => ({ key: motionKey(ref), label: motionLabel(inventory, ref), ref }));
  const actions = listActions(inventory, displayNames, switches);
  // 闲置默认全开：自治就是「自己随便动动」，不该预先排除什么。
  // 触发那一列不给默认值 —— 从旧版本升上来的走迁移，全新模型让用户自己挑。
  const idleDefault = actions.map(item => item.key);

  guard("state-motions", () => bindStateMotions(dir, motions));

  guard("actions", () => bindActions(dir, actions, idleDefault));
}

void boot();
