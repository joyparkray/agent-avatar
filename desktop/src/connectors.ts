import "./connectors.css";
import { invoke } from "@tauri-apps/api/core";
import { diagnosisReasons } from "./connector-diagnosis";
import { errorMessage } from "./errors";
import type { Language } from "./prefs";

/**
 * Agent connector 接入界面。首次运行的接入向导与设置页的「接入」区块**共用这一份** ——
 * 两处要显示的东西完全一样（五家 + 状态 + 安装/卸载 + 装完的手动步骤），
 * 各写一套必然会漂，而漂了之后表现是「设置里说已装、向导里说没装」。
 *
 * 装 / 卸都在 Rust 侧（`connector_install.rs`），这里只负责显示、按钮和回显它的报错。
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
  installRecord?: { at?: string; smoke_test?: string; python?: string; connector_version?: string;
                    /** 插件树的位置 —— 更新提示词靠它算出当初 clone 到哪儿了 */
                    source?: string } | null;
  /** harness 账本里的安装时间（ISO 8601）。只有 Claude Code 系的账本带。 */
  installedAt?: string | null;
}

/**
 * 接入的三档状态。**「装了」和「通了」是两回事**：插件目录在，只说明文件拷过去了；
 * 没 enable（Hermes）、没授信（Codex）、没重启（WorkBuddy）时目录照样在，
 * 而用户看到的是「已安装但形象一直不动」，没有任何线索。中间这档就是为它设的。
 */
export type LinkState = "missing" | "unconfigured" | "regressed" | "connected";

export function linkState(
  entry: Pick<ConnectorState, "installed" | "lastSignalSeconds" | "installedAt" | "installRecord">,
  now: number = Date.now(),
): LinkState {
  if (!entry.installed) return "missing";
  // 判据是「有没有写过」而不是「最近有没有写过」—— 一周没用那家 agent 的用户
  // 不该被告知需要重新配置。新旧程度只作为附注显示。
  if (typeof entry.lastSignalSeconds !== "number") return "unconfigured";

  // 🔴 但那次上报必须是**这次安装之后**的。状态文件在临时目录里，卸载不会删它 ——
  // 于是重装完还没开新会话时，界面就凭上一次安装留下的文件说「已连通」
  // （2026-09-03 实机：workbuddy 装完立刻显示已连通，而它一次新会话都还没跑）。
  // 那正好盖掉了中间那档，而中间那档存在的意义就是提醒用户「还差开一个新会话」。
  const installed = Date.parse(entry.installRecord?.at ?? entry.installedAt ?? "");
  if (Number.isFinite(installed) && now - entry.lastSignalSeconds * 1000 < installed) {
    // 🔴 上报过、但那次上报**早于这次安装** —— 这两件事合起来只有一个解释：
    // 以前是通的，重装/升级之后还没通。它和「从没上报过」处境完全不同，话也不该一样。
    //
    // 这是我们唯一能可靠识别「坏了」的时刻。光看状态文件区分不了「三天没用那个 agent」
    // 和「三天前坏了」—— 两者长得一模一样，所以别处不猜。而升级这一刻能分辨，
    // 因为我们知道自己刚重装过。Codex 尤其需要：它按 hook 的内容哈希记信任，
    // connector 一升级就必须重新点一次 /hooks，否则表现就是「app 更新完形象不动了」。
    return "regressed";
  }
  return "connected";
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
    hint: "选一个你在用的 agent，点「安装」就行。连接器和它需要的运行环境都在这个应用里，不联网、不下载。",
    "link.missing": "插件未安装，需安装插件",
    "link.unconfigured": "插件已安装，需人工配置",
    "link.regressed": "升级后还没重新连上",
    "link.connected": "插件正常，已连通",
    "details.show": "安装说明", "details.steps": "还需要你做这几步：",
    "details.none": "装完即用，没有额外步骤。新开一个会话就会生效。",
    "details.stale": "如果它之前一直是好的，多半是系统清理了临时目录；新开一次会话就会恢复。",
    "action.install": "安装",
    "action.repair": "修复",
    "action.reinstall": "重新安装",
    "action.uninstall": "卸载",
    "action.working": "正在处理…",
    "action.installed": "装好了。开一个新会话就会生效。",
    "action.removed": "已卸载。",
    "action.failed": "没成功：",
    "diagnosis.said": "插件自己报的错：",
    "diagnosis.python": "它用的解释器：",
    "diagnosis.title": "一直没通？可能是这些原因：",
    "diagnosis.regressed": "以前是通的，这次安装之后还没有上报过 —— 开一个新会话试试。",
    "diagnosis.regressed.codex": "Codex 按 hook 的内容哈希记忆信任，所以 connector 一升级就要**重新授信**：在 Codex 会话里跑 /hooks，逐条通过。",
    "diagnosis.fresh": "刚装好，等你开一个新会话就会生效。",
    "diagnosis.freshVerified": "刚装好，安装时已自检通过 —— 等你开一个新会话就会生效。",
    done: "完成",
    listFailed: "读不到接入状态：",
    loading: "读取中…",
    skip: "以后再说",
  },
  en: {
    title: "Connect your agent",
    hint: "Pick the agent you use and press Install. The connector and the runtime it needs are inside this app — nothing is downloaded.",
    "link.missing": "Plugin not installed — install it",
    "link.unconfigured": "Installed — needs manual setup",
    "link.regressed": "Not reconnected since the upgrade",
    "link.connected": "Connected and working",
    "details.show": "Setup guide", "details.steps": "You still need to:",
    "details.none": "Nothing else to do. It takes effect in your next session.",
    "details.stale": "If it used to work, the temp directory was probably cleaned — start a new session to restore it.",
    "action.install": "Install",
    "action.repair": "Repair",
    "action.reinstall": "Reinstall",
    "action.uninstall": "Uninstall",
    "action.working": "Working…",
    "action.installed": "Installed. It takes effect in your next session.",
    "action.removed": "Uninstalled.",
    "action.failed": "Didn't work: ",
    "diagnosis.said": "The plugin reported: ",
    "diagnosis.python": "Interpreter it used: ",
    "diagnosis.title": "Still not connected? It could be:",
    "diagnosis.regressed": "This used to work, but nothing has been reported since this install — start a new session.",
    "diagnosis.regressed.codex": "Codex keys hook trust to the hook's content hash, so a connector upgrade needs **re-trusting**: run /hooks in a Codex session and approve each one.",
    "diagnosis.fresh": "Just installed. It takes effect when you start a new session.",
    "diagnosis.freshVerified": "Just installed and self-tested at install time — it takes effect when you start a new session.",
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
  host.textContent = text("loading");
  const rows = new Map<string, HTMLElement>();
  const say = (harness: string, message: string, kind: "" | "ok" | "error" = "") => {
    const status = rows.get(harness);
    if (!status) return;
    status.textContent = message;
    status.className = `connector-status ${kind}`;
  };

  /**
   * 跑一次装 / 卸，然后**重画**。
   *
   * 🔴 结果一律以重画后的状态为准，不以命令返回值为准。Rust 那边已经在装完时喂过一条真事件
   * 确认状态文件落盘，但「装上了」和「通了」仍是两回事（还差一个新会话，Codex 还差授信）——
   * 界面要说的是后者，而后者只有重新读一次状态才知道。
   *
   * 失败时把**它自己的原话**贴出来。这条链路上唯一有用的线索就是 harness 的输出
   * （「Marketplace undefined is not found.」这种），我们改写一遍只会让它变模糊。
   */
  const act = (harness: string, command: "install_connector" | "uninstall_connector") => {
    say(harness, text("action.working"));
    host.querySelectorAll("button").forEach(button => { button.disabled = true; });
    void invoke(command, { harness }).then(
      () => renderConnectors(host, locale, onChange, {
        harness,
        message: text(command === "install_connector" ? "action.installed" : "action.removed"),
        kind: "ok",
      }),
      (error: unknown) => renderConnectors(host, locale, onChange, {
        harness, message: `${text("action.failed")}${errorMessage(error, locale)}`, kind: "error",
      }),
    ).then(() => onChange?.());
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
      // 这里曾经有一句「你装的是 1.0.0，最新 1.2.0」。connector 现在随 app 一起发布，
      // 两者永远同版本 —— 那句话没有可能为真了，连同版本比较一起删掉。
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
      if (state === "regressed" && steps.length === 0) details.textContent += `\n${text("details.stale")}`;
      const toggle = document.createElement("button");
      toggle.type = "button"; toggle.className = "ghost"; toggle.textContent = text("details.show");
      toggle.setAttribute("aria-expanded", "false");
      const showDetails = (on: boolean) => { details.hidden = !on; toggle.setAttribute("aria-expanded", String(on)); };
      toggle.addEventListener("click", () => showDetails(details.hidden));
      // 需人工配置时直接摊开：这一档的用户正卡在这里，还要他多点一次才看得到步骤没有道理。
      if ((state === "unconfigured" || state === "regressed") && steps.length > 0) showDetails(true);
      actions.append(toggle);


      // 🔴 **app 自己装。**
      //
      // 上一版是「app 出一段提示词、用户粘给手边的 agent、agent 去跑命令」。两轮实机测试
      // （提示词交给真实的四个 CLI）一共暴露 14 个缺陷，成因是同一件事：提示词是一段程序，
      // 而执行它的解释器不确定。详见 private/RELEASE-CONNECTOR-WIZARD-DESIGN.md。
      //
      // 装是 Rust 那边做的：铺工作副本 → 把自带解释器写进 hook 命令行 → 喂真事件自检 →
      // **调 harness 自己的 CLI** 去登记（不写它的配置文件）。
      const primary = document.createElement("button");
      primary.type = "button";
      primary.className = state === "connected" ? "ghost" : "primary";
      primary.textContent = text(state === "missing" ? "action.install"
        : state === "connected" ? "action.reinstall" : "action.repair");
      primary.addEventListener("click", () => act(harness, "install_connector"));
      actions.append(primary);

      if (installed) {
        // 卸载同样交给 harness 自己的 CLI。这个按钮曾经是「删我们猜的那两个目录」——
        // 而那两个目录对现在的布局根本不存在，于是它删掉零个文件、报告成功，账本原封不动
        // （2026-09-03 实测）。**报告成功、什么都没变**，是这个项目最该防的那个形状。
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "ghost";
        remove.textContent = text("action.uninstall");
        remove.addEventListener("click", () => act(harness, "uninstall_connector"));
        actions.append(remove);
      }

      // 「装了但从没上报」这一档：光说「需人工配置」不够 —— 用户已经卡住了，
      // 他需要的是「可能是哪儿」和「怎么查」。杀软那一条尤其要写出来：
      // 文件被删掉之后，界面上只表现为「装了但不动」，普通用户永远想不到那儿去。
      const diagnosis = document.createElement("div");
      if (state === "unconfigured" || state === "regressed") {
        diagnosis.className = "connector-diagnosis";
        // 「装了但从没上报」在刚装完的几分钟里是**正常的**（还没开新会话），
        // 过了一天才是故障。原来这两种情况给的是同一段五条排查清单 ——
        // 对刚装完的人来说，那等于告诉他「你可能哪儿都错了」，而其实他什么都没做错。
        const installed = entry.installRecord?.at || entry.installedAt;
        const freshInstall = installed ? Date.now() - Date.parse(installed) < FRESH_INSTALL_MS : false;
        const title = document.createElement("p");
        title.className = "connector-diagnosis-title";
        title.textContent = state === "regressed"
          ? text("diagnosis.regressed")
          : freshInstall
            ? text(entry.installRecord?.smoke_test === "passed" ? "diagnosis.freshVerified" : "diagnosis.fresh")
            : text("diagnosis.title");
        diagnosis.append(title);
        // 升级后没连上时，Codex 的原因几乎总是同一个，所以把它顶到猜测清单前面 ——
        // 让他先读五条「可能是」再读到真正那条，等于把答案藏起来。
        if (state === "regressed" && harness === "codex") {
          const why = document.createElement("p");
          why.className = "connector-diagnosis-said";
          why.textContent = text("diagnosis.regressed.codex");
          diagnosis.append(why);
        }
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
        // 刚装完那几分钟不摊清单：那时「还没上报」是正常的（还没开新会话），
        // 给他五条「可能是」等于告诉他「你可能哪儿都错了」，而他什么都没做错。
        if (!freshInstall || state === "regressed") {
          for (const reason of diagnosisReasons(harness, locale)) {
            const item = document.createElement("li"); item.textContent = reason; reasons.append(item);
          }
        }
        diagnosis.append(reasons);
      }

      row.append(name, actions, link, status, details, diagnosis);
      host.append(row);
    }
    if (pending) say(pending.harness, pending.message, pending.kind);
  });
}
