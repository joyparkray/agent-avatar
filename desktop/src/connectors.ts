import "./connectors.css";
import { invoke } from "@tauri-apps/api/core";
import { CONNECTOR_VERSION, diagnosePrompt, diagnosisReasons, installPrompt, isOutdated, uninstallPrompt } from "./connector-diagnosis";
import { errorMessage } from "./errors";
import type { Language } from "./prefs";

/**
 * Agent connector 接入界面。首次运行的接入向导与设置页的「接入」区块**共用这一份** ——
 * 两处要显示的东西完全一样（五家 + 状态 + 安装/卸载 + 装完的手动步骤），
 * 各写一套必然会漂，而漂了之后表现是「设置里说已装、向导里说没装」。
 *
 * 下载/解压/执行都在 Rust 侧（见 src-tauri/src/connectors.rs），这里只负责显示与回显。
 */
export const CONNECTOR_HARNESSES = ["claude-code", "codex", "dsh", "hermes", "workbuddy"] as const;
export type Harness = typeof CONNECTOR_HARNESSES[number];

/** 各家自己的写法，不翻译 —— 用户要在自己的工具里找到同一个名字。 */
export const HARNESS_LABELS: Record<Harness, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  dsh: "DeepSeek (dsh)",
  hermes: "Hermes",
  workbuddy: "WorkBuddy",
};

/**
 * 装完多久之内算「刚装好」。**这不是超时**：过了这个点插件照样可能正常，
 * 只是我们不再默认「他还没开新会话」——那时候把排查清单摊开才是有用的。
 * 半小时足够任何人开一个新会话，又短到不会让真出问题的人一直等。
 */
const FRESH_INSTALL_MS = 30 * 60 * 1000;

export interface ConnectorState {
  harness: string;
  installed: boolean;
  path?: string | null;
  /** 这家的 hook 最后一次写状态文件是多久以前（秒）。从没写过 = null，见 Rust 侧注释。 */
  lastSignalSeconds?: number | null;
  /** connector 自己上报的版本。没上报过（没装 / 旧版没写这个字段）= null。 */
  connectorVersion?: string | null;
  /** hook 最后一次出错留下的记录（第 2 层诊断）。从没出过错 = null。 */
  diagnostic?: { at?: string; message?: string; python?: string } | null;
  /** 装机时那次验证的记录：`localize.py` 跑通冒烟自检才会有。不是「装没装」的证据。 */
  installRecord?: { at?: string; smoke_test?: string; python?: string; connector_version?: string } | null;
  /** harness 账本里的安装时间（ISO 8601）。只有 Claude Code 系的账本带。 */
  installedAt?: string | null;
}

/**
 * 接入的三档状态。**「装了」和「通了」是两回事**：插件目录在，只说明文件拷过去了；
 * 没 enable（Hermes）、没授信（Codex）、没重启（WorkBuddy）时目录照样在，
 * 而用户看到的是「已安装但形象一直不动」，没有任何线索。中间这档就是为它设的。
 */
export type LinkState = "missing" | "unconfigured" | "connected";

export function linkState(entry: Pick<ConnectorState, "installed" | "lastSignalSeconds">): LinkState {
  if (!entry.installed) return "missing";
  // 判据是「有没有写过」而不是「最近有没有写过」—— 一周没用那家 agent 的用户
  // 不该被告知需要重新配置。新旧程度只作为附注显示。
  return typeof entry.lastSignalSeconds === "number" ? "connected" : "unconfigured";
}

/**
 * 中间档的说法要看这家**到底有没有人工步骤**。
 * Claude Code 与 dsh 装完即用，对它们说「需人工配置」是把用户支去做一件不存在的事 ——
 * 真正的原因是还没开过新会话。标签因此分成两句，其余两档共用。
 */
export function statusLabel(state: LinkState, harness: string, locale: Language): string {
  if (state === "unconfigured" && postInstallSteps(harness, locale).length === 0) {
    return locale === "en" ? "Installed · waiting for the first session" : "插件已安装，等待首次会话";
  }
  return CONNECTOR_TEXT[locale][`link.${state}`];
}

/** 最后一次收到信号有多久。粗粒度即可 —— 用户要的是「刚才还在动」而不是精确秒数。 */
export function freshness(seconds: number, locale: Language): string {
  const en = locale === "en";
  if (seconds < 120) return en ? "just now" : "刚刚";
  if (seconds < 3600) return en ? `${Math.round(seconds / 60)} min ago` : `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return en ? `${Math.round(seconds / 3600)} hr ago` : `${Math.round(seconds / 3600)} 小时前`;
  return en ? `${Math.round(seconds / 86400)} days ago` : `${Math.round(seconds / 86400)} 天前`;
}

export const CONNECTOR_TEXT: Record<Language, Record<string, string>> = {
  "zh-CN": {
    title: "接入你的 Agent",
    hint: "选一个你在用的 agent，复制一段话贴给它 —— 装 connector 这件事由它来做。命令都是钉死的，你可以先读一遍再让它跑。",
    "link.missing": "插件未安装，需安装插件",
    "link.unconfigured": "插件已安装，需人工配置",
    "link.connected": "插件正常，已连通",
    "details.show": "安装说明", "details.steps": "还需要你做这几步：",
    "details.none": "装完即用，没有额外步骤。新开一个会话就会生效。",
    "details.stale": "如果它之前一直是好的，多半是系统清理了临时目录；新开一次会话就会恢复。",
    "version.outdated": "connector {have}，最新 {latest}",
    "version.unknown": "版本未知",
    "prompt.update": "复制更新提示词",
    "prompt.install": "复制安装提示词",
    "prompt.uninstall": "复制卸载提示词",
    "prompt.reinstall": "复制重装提示词",
    "prompt.copied": "已复制，贴给你的 agent 就行",
    "prompt.copyFailed": "复制不了，请手动选中下面这段：",
    "diagnosis.said": "插件自己报的错：",
    "diagnosis.python": "它用的解释器：",
    "diagnosis.title": "一直没通？可能是这些原因：",
    "diagnosis.fresh": "刚装好，等你开一个新会话就会生效。",
    "diagnosis.freshVerified": "刚装好，安装时已自检通过 —— 等你开一个新会话就会生效。",
    "diagnosis.ask": "复制排查提示词",
    done: "完成",
    listFailed: "读不到接入状态：",
    loading: "读取中…",
    skip: "以后再说",
  },
  en: {
    title: "Connect your agent",
    hint: "Pick the agent you use and copy a prompt for it — installing the connector is its job. The commands are fixed, so you can read them before letting it run.",
    "link.missing": "Plugin not installed — install it",
    "link.unconfigured": "Installed — needs manual setup",
    "link.connected": "Connected and working",
    "details.show": "Setup guide", "details.steps": "You still need to:",
    "details.none": "Nothing else to do. It takes effect in your next session.",
    "details.stale": "If it used to work, the temp directory was probably cleaned — start a new session to restore it.",
    "version.outdated": "connector {have}, latest is {latest}",
    "version.unknown": "unknown version",
    "prompt.update": "Copy update prompt",
    "prompt.install": "Copy install prompt",
    "prompt.uninstall": "Copy uninstall prompt",
    "prompt.reinstall": "Copy reinstall prompt",
    "prompt.copied": "Copied — paste it to your agent",
    "prompt.copyFailed": "Couldn't copy. Select this text instead:",
    "diagnosis.said": "The plugin reported: ",
    "diagnosis.python": "Interpreter it used: ",
    "diagnosis.title": "Still not connected? It could be:",
    "diagnosis.fresh": "Just installed. It takes effect when you start a new session.",
    "diagnosis.freshVerified": "Just installed and self-tested at install time — it takes effect when you start a new session.",
    "diagnosis.ask": "Copy a prompt for your agent",
    done: "Done",
    listFailed: "Could not read connector status: ",
    loading: "Loading…",
    skip: "Not now",
  },
};

/**
 * 装完之后**应用替用户做不了**的那几步。
 *
 * 这些步骤要么需要在对方的会话里操作（Codex 的 `/hooks` 授信），要么需要重启对方的进程 ——
 * 替用户跑既做不到也不该做。不说的话表现是「装完了没反应」，而用户没有办法知道为什么。
 */
export function postInstallSteps(harness: string, locale: Language): string[] {
  const zh = locale !== "en";
  switch (harness) {
    case "hermes":
      return zh
        ? ["在终端里运行：hermes plugins enable agent-avatar", "已经在跑的 Hermes 会话不会加载新插件，需要重启对应进程。"]
        : ["Run in a terminal: hermes plugins enable agent-avatar", "Sessions already running will not pick up the plugin — restart them."];
    case "workbuddy":
      return zh
        ? ["重启 WorkBuddy app —— 插件在启动时才被加载。"]
        : ["Restart the WorkBuddy app — plugins are loaded at startup."];
    case "codex":
      return zh
        ? ["在 Codex 会话里运行 /hooks，逐条授信 Agent Avatar 的 hook。未授信的 hook 会被一直跳过，这是安全设计，不是故障。",
           "connector 升级后需要重新授信：Codex 按 hook 的内容哈希记忆信任。"]
        : ["Run /hooks inside a Codex session and trust each Agent Avatar hook. Untrusted hooks are silently skipped by design.",
           "Re-trust after a connector upgrade: Codex keys trust to the hook's content hash."];
    default:
      // claude-code / dsh：装完即用，没有额外步骤。
      return [];
  }
}

const tr = (locale: Language, key: string): string => CONNECTOR_TEXT[locale][key] ?? key;

/**
 * **失败不能当成「一家都没装」**：`list_connectors` 被拒（命令没登记进
 * `permissions/skin.toml` 就会这样）或出错时，原来的 `.catch(() => [])` 让界面把五家
 * 全显示成「未安装」—— 一个坏掉的通道长得和一台干净的机器一模一样，
 * 而用户照着它去点安装只会把已经装好的东西再装一遍。出错就说出错。
 */
const listConnectors = (): Promise<ConnectorState[]> => invoke<ConnectorState[]>("list_connectors");

/** 装/卸完成后要显示的一条提示。重画会把整棵 DOM 换掉，提示得跟着搬过去。 */
interface Pending { harness: string; message: string; kind: "ok" | "error" }

/**
 * 把五家渲染进 `host`。重复调用会重画（安装完刷新状态走的就是同一条路径）。
 *
 * `onChange` 在装/卸成功后回调 —— 首次向导据此知道用户已经接上了一家。
 */
export function renderConnectors(host: HTMLElement, locale: Language, onChange?: () => void, pending?: Pending): void {
  const text = (key: string) => tr(locale, key);
  /**
   * 复制一段提示词，并把原文摊在下面。
   *
   * **原文一定要摊开**，不只是为了剪贴板不可用时兜底（webview 里它确实不保证可用）：
   * 这段话是要交给一个能执行命令的 agent 的，用户有权在按下去之前看清楚它写了什么。
   */
  const copyPrompt = (harness: string, prompt: string) => {
    const box = prompts.get(harness);
    if (box) { box.value = prompt; box.hidden = false; }
    const done = () => say(harness, text("prompt.copied"), "ok");
    const fallback = () => { box?.select(); say(harness, text("prompt.copyFailed"), "error"); };
    try {
      void navigator.clipboard.writeText(prompt).then(done, fallback);
    } catch { fallback(); }
  };
  host.textContent = text("loading");
  const rows = new Map<string, HTMLElement>();
  const prompts = new Map<string, HTMLTextAreaElement>();
  const say = (harness: string, message: string, kind: "" | "ok" | "error" = "") => {
    const status = rows.get(harness);
    if (!status) return;
    status.textContent = message;
    status.className = `connector-status ${kind}`;
  };
  void listConnectors().catch(error => {
    host.textContent = "";
    const failed = document.createElement("p");
    failed.className = "connector-status error";
    failed.textContent = `${text("listFailed")}${errorMessage(error, locale)}`;
    host.append(failed);
    return undefined;
  }).then(states => {
    if (!states) return;
    const known = new Map(states.map(state => [state.harness, state]));
    host.textContent = "";
    for (const harness of CONNECTOR_HARNESSES) {
      const entry = known.get(harness) ?? { harness, installed: false };
      const state = linkState(entry);
      const installed = state !== "missing";
      const steps = postInstallSteps(harness, locale);

      const row = document.createElement("div");
      row.className = "connector-row";
      row.dataset.link = state;
      const name = document.createElement("span");
      name.className = "connector-name"; name.textContent = HARNESS_LABELS[harness];
      const actions = document.createElement("span");
      actions.className = "connector-actions";

      // 三档状态一行说清。颜色只是辅助，文字本身必须能独立读懂 ——
      // 「已安装」和「已连通」差的正是用户卡住的那一步。
      const link = document.createElement("p");
      link.className = "connector-link";
      const dot = document.createElement("i"); dot.className = "dot";
      const linkText = document.createElement("span");
      linkText.textContent = statusLabel(state, harness, locale);
      if (state === "connected" && typeof entry.lastSignalSeconds === "number") {
        linkText.textContent += ` · ${freshness(entry.lastSignalSeconds, locale)}`;
      }
      // 通了、但装的是旧版：Windows 上那份是本地化过的副本，收不到 harness 的自动更新，
      // 不说的话用户永远停在旧版。**只在真的通了之后说** —— 没通的时候他有更要紧的问题。
      const outdated = state === "connected" && isOutdated(entry.connectorVersion);
      if (outdated) {
        linkText.textContent += ` · ${text("version.outdated")
          .replace("{have}", entry.connectorVersion ?? text("version.unknown"))
          .replace("{latest}", CONNECTOR_VERSION)}`;
      }
      link.append(dot, linkText);

      const status = document.createElement("p");
      status.className = "connector-status";
      rows.set(harness, status);

      // 安装说明：默认收起，点开看这家要做什么。**装之前也能看**——
      // 用户有权在动手前知道这一家会要求他做什么（Codex 的 /hooks 授信不是小事）。
      const details = document.createElement("div");
      details.className = "connector-details"; details.hidden = true;
      details.textContent = steps.length ? `${text("details.steps")}\n${steps.map(step => `· ${step}`).join("\n")}` : text("details.none");
      // 「之前通过、现在没信号」是临时目录被清了，不是配置坏了。不说的话用户会去重装。
      if (state === "unconfigured" && steps.length === 0) details.textContent += `\n${text("details.stale")}`;
      const toggle = document.createElement("button");
      toggle.type = "button"; toggle.className = "ghost"; toggle.textContent = text("details.show");
      toggle.setAttribute("aria-expanded", "false");
      const showDetails = (on: boolean) => { details.hidden = !on; toggle.setAttribute("aria-expanded", String(on)); };
      toggle.addEventListener("click", () => showDetails(details.hidden));
      // 需人工配置时直接摊开：这一档的用户正卡在这里，还要他多点一次才看得到步骤没有道理。
      if (state === "unconfigured" && steps.length > 0) showDetails(true);
      actions.append(toggle);


      // 🔴 **app 不装 connector。** 它给用户一段可粘贴的话，由用户的 agent 去执行。
      // 那条路比 app 自己装干净得多：没有下载（也就没有 Mark of the Web）、
      // 没有未签名脚本改配置（实机撞到过：卡巴斯基把安装脚本判成 PDM:Trojan.Win32.Generic
      // 并直接删除），而且 agent 能做 app 做不了的事 —— 缺 Python 时它可以（在用户点头后）
      // 装一个、看得懂报错、还能重试。
      const install = document.createElement("button");
      if (!installed) install.className = "primary";
      install.textContent = text(outdated ? "prompt.update" : installed ? "prompt.reinstall" : "prompt.install");
      if (outdated) install.className = "primary";      // 这一行现在有事要做，让它看得出来
      install.addEventListener("click", () => copyPrompt(harness, installPrompt(harness, locale)));
      actions.append(install);

      if (installed) {
        // 🔴 **卸载也交给 agent**，和安装同一条路。
        //
        // 原来这里调 Rust 去删目录 —— 而那条路对「从远程 marketplace 装」的那套完全没用：
        // 它删的两个目录都不存在，于是删掉零个文件、报告成功，而 harness 的账本原封不动
        // （2026-09-03 实测）。**报告成功、什么都没变**，正是我们一整天在打的那个形状。
        //
        // 根因和安装那边一样：装是 harness 干的，它的布局我们追不动。卸载用它自己的
        // `plugin uninstall`，它最清楚东西在哪 —— 顺带连缓存副本一起清掉。
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "ghost";
        remove.textContent = text("prompt.uninstall");
        remove.addEventListener("click", () => copyPrompt(harness, uninstallPrompt(harness, locale)));
        actions.append(remove);
      }

      // 每一行都有一个提示词框：点「复制」时把原文摊在这里，用户按下去之前看得见它写了什么。
      const prompt = document.createElement("textarea");
      prompt.className = "connector-prompt"; prompt.hidden = true; prompt.readOnly = true; prompt.rows = 8;
      prompts.set(harness, prompt);

      // 「装了但从没上报」这一档：光说「需人工配置」不够 —— 用户已经卡住了，
      // 他需要的是「可能是哪儿」和「怎么查」。杀软那一条尤其要写出来：
      // 文件被删掉之后，界面上只表现为「装了但不动」，普通用户永远想不到那儿去。
      const diagnosis = document.createElement("div");
      if (state === "unconfigured") {
        diagnosis.className = "connector-diagnosis";
        // 「装了但从没上报」在刚装完的几分钟里是**正常的**（还没开新会话），
        // 过了一天才是故障。原来这两种情况给的是同一段五条排查清单 ——
        // 对刚装完的人来说，那等于告诉他「你可能哪儿都错了」，而其实他什么都没做错。
        const installed = entry.installRecord?.at || entry.installedAt;
        const freshInstall = installed ? Date.now() - Date.parse(installed) < FRESH_INSTALL_MS : false;
        const title = document.createElement("p");
        title.className = "connector-diagnosis-title";
        title.textContent = freshInstall
          ? text(entry.installRecord?.smoke_test === "passed" ? "diagnosis.freshVerified" : "diagnosis.fresh")
          : text("diagnosis.title");
        diagnosis.append(title);
        // hook 自己留下的那条**具体原因**排在所有猜测之前 —— 有实据时不该让用户先读五条
        // 「可能是」。它只在这一档显示：已经通了的时候，那多半是一条陈年旧错。
        const recorded = entry.diagnostic?.message?.trim();
        if (recorded) {
          const said = document.createElement("p");
          said.className = "connector-diagnosis-said";
          said.textContent = `${text("diagnosis.said")}${recorded}`;
          if (entry.diagnostic?.python) said.textContent += `
${text("diagnosis.python")}${entry.diagnostic.python}`;
          diagnosis.append(said);
        }
        const reasons = document.createElement("ul");
        if (!freshInstall) {
          for (const reason of diagnosisReasons(harness, locale)) {
            const item = document.createElement("li"); item.textContent = reason; reasons.append(item);
          }
        }
        const ask = document.createElement("button");
        ask.type = "button"; ask.className = "ghost"; ask.textContent = text("diagnosis.ask");
        ask.addEventListener("click", () => copyPrompt(harness, diagnosePrompt(harness, locale)));
        diagnosis.append(reasons, ask);
      }

      row.append(name, actions, link, status, details, diagnosis, prompt);
      host.append(row);
    }
    if (pending) say(pending.harness, pending.message, pending.kind);
  });
}
