import type { Language } from "./prefs";

/**
 * 「装了，但从没上报过」时该说什么，以及给用户一句能直接贴给 agent 的话。
 *
 * 为什么单独一个文件：这不是「装完还要做什么」（那是 `postInstallSteps`，是**流程**），
 * 而是「**已经按流程做完了，却还是不通**」时的排查清单 —— 两者的读者处境完全不同。
 * 前者的用户在往前走，后者的用户卡住了，而卡住的人需要的是「可能是哪儿」和「怎么查」。
 *
 * 🔴 这是三层诊断里的**第 3 层**（见 private/RELEASE-CONNECTOR-WIZARD-DESIGN.md
 * 「失效怎么被看见」）：插件根本没跑起来时我们的代码一行都没执行，写不了任何诊断文件，
 * 所以这一层只能由 app 从外面判断 —— `installed && lastSignal == null` 就是它。
 *
 * 装 connector 的提示词也在这里。app **不下载、不解压、不跑脚本**（那三步正是杀软误报的
 * 来源，实机被卡巴删过文件）—— 它只把一段钉死的命令交给用户的 agent 去执行。
 */

/**
 * connector 的发布仓库。**必须与 connectors/build-marketplace.sh 里的 `REPO` 一致**
 * （有测试盯着）—— 两处各写一份必然会漂，而漂了之后表现是「照提示词跑完，装的是另一个仓库」。
 */
export const MARKETPLACE_REPO = "joyparkray/agent-avatar-connectors";

/**
 * 这个版本的 app 配套的 connector 版本。**必须与 bridge/state_machine.py 的
 * `CONNECTOR_VERSION` 一致**（有测试盯着）。
 *
 * 拿它和 connector 上报的版本比，就能说出「你装的是 1.0.0，最新 1.2.0」。
 * 之所以需要这条：Windows 上装的是**本地化过的副本**（解释器路径写死在里面），
 * 收不到 harness 的自动更新 —— 更新因此是显式的，那就得有人把「该更新了」说出来。
 */
export const CONNECTOR_VERSION = "1.0.0";

/** 上报的版本和 app 配套的对不上时，该不该提示更新。没上报过版本的（旧 connector）也算。 */
export function isOutdated(reported: string | null | undefined): boolean {
  return reported !== CONNECTOR_VERSION;
}

/** 各家的状态文件名。Hermes 沿用无后缀的老路径（已装好的用户不该因为改名就断掉）。 */
export function stateFileName(harness: string): string {
  return harness === "hermes" ? "agent-avatar-state.json" : `agent-avatar-state.${harness}.json`;
}

/**
 * 为什么可能「装了却没上报」。**顺序即概率**：最常见的原因排前面，
 * 用户多半只会看头两条。
 *
 * 每家都必须包含「杀毒软件删了文件」这一条 —— 2026-09-02 实机发生过：
 * 卡巴斯基把我们的安装脚本判成 `PDM:Trojan.Win32.Generic` 并**直接删除**。
 * 那是行为分析的误报（未签名脚本改用户目录下另一个应用的配置），普通用户完全无从下手：
 * 文件消失了，界面上只表现为「装了但不动」。不写出来，这条线索就永远不会被想到。
 */
export function diagnosisReasons(harness: string, locale: Language): string[] {
  const zh = locale !== "en";
  const shared = zh
    ? ["还没有开过新会话 —— 插件是在会话启动时加载的，已经在跑的会话不会自己加载。",
       "杀毒软件把插件文件删了。已知卡巴斯基会把这类安装脚本判成 PDM:Trojan.Win32.Generic 并直接删除；去它的隔离区找一下。",
       "这台机器上没有可用的 Python。Windows 上的 python3 常常是应用商店的占位程序（0 字节），看起来存在、其实跑不起来。"]
    : ["No new session has started yet — plugins load at session start, and sessions already running won't pick it up.",
       "Your antivirus deleted the plugin files. Kaspersky is known to flag this kind of installer as PDM:Trojan.Win32.Generic and remove it outright — check its quarantine.",
       "There is no usable Python on this machine. On Windows, python3 is often a 0-byte Microsoft Store placeholder: it looks present but cannot run."];

  const specific: Record<string, string[]> = {
    "claude-code": zh
      ? ["插件文件在，但没被登记 —— 光把文件拷进插件目录是不会被发现的，要在 marketplace 里注册并安装。跑 claude plugin list 看它是不是 enabled。"]
      : ["The files are there but the plugin isn't registered — copying files into the plugin folder is not enough; it must be added as a marketplace and installed. Run claude plugin list and check it says enabled."],
    codex: zh
      ? ["hooks 还没授信。这是最常见的一条：启用插件**不会**自动信任它的 hook，未授信的 hook 会被一直跳过 —— 这是安全设计，不是故障。在 Codex 会话里跑 /hooks 逐条授信。",
         "ChatGPT app 没有完全退出再打开。插件在启动时才被发现。",
         "connector 升级后需要重新授信：Codex 按 hook 的内容哈希记忆信任。"]
      : ["The hooks aren't trusted yet. This is the most common one: enabling a plugin does not trust its hooks, and untrusted hooks are skipped silently — by design. Run /hooks inside a Codex session and trust each one.",
         "The ChatGPT app wasn't fully quit and reopened. Plugins are discovered at startup.",
         "After a connector upgrade you must re-trust: Codex keys trust to the hook's content hash."],
    workbuddy: zh
      ? ["WorkBuddy app 没有重启 —— 插件在启动时才加载。",
         "装错了配置目录。同一个 CLI 有两个 home：app 读 ~/.workbuddy，独立 CLI 默认读 ~/.codebuddy。装错那个的表现是「命令行怎么测都正常、app 里完全没反应」。"]
      : ["The WorkBuddy app hasn't been restarted — plugins load at startup.",
         "It went into the wrong config directory. The same CLI has two homes: the app reads ~/.workbuddy, the standalone CLI defaults to ~/.codebuddy. Getting this wrong looks like \"works on the command line, does nothing in the app\"."],
    dsh: zh
      ? ["$DSH_HOME/cordis.patch.yml 里那段 agent-avatar 的 insert 不见了或被覆盖了。",
         "插件里那次调用找不到 Python。dsh 这条链路把 stderr 丢弃了，所以失败时**一点声音都没有** —— 这是五家里最难查的一种。"]
      : ["The agent-avatar insert block in $DSH_HOME/cordis.patch.yml is gone or was overwritten.",
         "The plugin can't find Python. This path discards stderr, so the failure makes no sound at all — the hardest of the five to diagnose."],
    hermes: zh
      ? ["插件还没启用：hermes plugins enable agent-avatar。",
         "已经在跑的 Hermes 会话不会加载新插件，要重启对应进程。"]
      : ["The plugin isn't enabled yet: hermes plugins enable agent-avatar.",
         "Hermes sessions already running won't load a new plugin — restart them."],
  };
  return [...(specific[harness] ?? []), ...shared];
}

/**
 * 可直接粘贴给 agent 的排查提示词。
 *
 * 🔴 **里面必须是钉死的命令，不能是「去找找看」**（方案 5 的边界）：提示词会被复制、
 * 转发、改写，只有当它退化成「执行这几条确定的命令」时，用户和我们才都能确认它做了什么。
 * 同理，最后一句明确要求**不要改任何东西** —— 排查和修复是两件事，
 * 而修复里有些步骤（Codex 的 /hooks 授信）本来就只能由人来点。
 */
export function diagnosePrompt(harness: string, locale: Language): string {
  const zh = locale !== "en";
  const file = stateFileName(harness);
  const checks: Record<string, string[]> = {
    "claude-code": ["claude plugin list"],
    codex: zh
      ? ["查看 ~/.codex/config.toml 里有没有这两段：[marketplaces.agent-avatar-local] 和 [plugins.\"agent-avatar@agent-avatar-local\"]"]
      : ["Check ~/.codex/config.toml for both [marketplaces.agent-avatar-local] and [plugins.\"agent-avatar@agent-avatar-local\"]"],
    workbuddy: ["codebuddy plugin list"],
    dsh: zh
      ? ["查看 $DSH_HOME/cordis.patch.yml 里还有没有 agent-avatar 那一段"]
      : ["Check whether the agent-avatar block is still in $DSH_HOME/cordis.patch.yml"],
    hermes: ["hermes plugins list"],
  };
  const first = checks[harness] ?? [];
  const lines = zh
    ? [`帮我查一下 Agent Avatar 的 ${harness} connector 为什么没有上报状态。按顺序做这几步，把结果贴给我：`,
       "",
       ...first.map((check, index) => `${index + 1}) ${check}`),
       `${first.length + 1}) 看状态文件在不在：Windows 是 %TEMP%\\${file}，macOS/Linux 是 $TMPDIR/${file}（没有 TMPDIR 就是 /tmp）`,
       `${first.length + 2}) 如果上面显示插件是启用的、但状态文件不存在，就检查杀毒软件的隔离区 —— 已知卡巴斯基会把这类文件判成 PDM:Trojan.Win32.Generic 并直接删掉`,
       `${first.length + 3}) 确认这台机器上有能跑的 Python：python -c "import sys; print(sys.executable)"（Windows 上 python3 常常是 0 字节的应用商店占位程序）`,
       "",
       "只报告结果，先不要改任何配置。"]
    : [`Help me find out why the Agent Avatar ${harness} connector never reports status. Do these in order and paste the results back:`,
       "",
       ...first.map((check, index) => `${index + 1}) ${check}`),
       `${first.length + 1}) Check whether the state file exists: %TEMP%\\${file} on Windows, $TMPDIR/${file} on macOS/Linux (/tmp if TMPDIR is unset)`,
       `${first.length + 2}) If the plugin shows as enabled but the state file is missing, check your antivirus quarantine — Kaspersky is known to flag these files as PDM:Trojan.Win32.Generic and delete them`,
       `${first.length + 3}) Confirm this machine has a working Python: python -c "import sys; print(sys.executable)" (on Windows, python3 is often a 0-byte Store placeholder)`,
       "",
       "Report what you find. Don't change any configuration yet."];
  return lines.join("\n");
}

/** 这台机器要不要那一步「本地化」。只有 Windows 要 —— POSIX 上 `python3` 本来就是对的。 */
export type Platform = "windows" | "posix";

export function currentPlatform(): Platform {
  return /win/i.test(navigator.userAgent) ? "windows" : "posix";
}

/** 各家用哪个 CLI 装。dsh 与 hermes 不走 marketplace，见下面的分支。 */
const MARKETPLACE_CLI: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  workbuddy: "codebuddy",
};

/**
 * 装 connector 的提示词 —— 直接贴给 agent。
 *
 * 🔴 **里面必须是钉死的命令。** 提示词会被复制、转发、改写，别处流传的仿冒版本可以指向
 * 任何地方；只有当它退化成「执行这几条确定的命令」时，用户和我们才都能确认它做了什么。
 * 所以这里绝不写「帮我装一下 Agent Avatar」，而是写清楚仓库、命令、参数。
 *
 * 两条边界写进提示词本身：
 * - **授信 / 登录这类要人点头的步骤不许代做**（Codex 的 `/hooks` 尤其）。它们存在的意义
 *   就是「让人看一眼再点头」，让 agent 代做等于把这道防线拆了。
 * - **装 Python 要先问用户**。在别人机器上装软件应当由机器的主人点头。
 */
export function installPrompt(harness: string, locale: Language, platform: Platform = currentPlatform()): string {
  const zh = locale !== "en";
  const cli = MARKETPLACE_CLI[harness];
  const windows = platform === "windows";
  const clone = [
    `git clone https://github.com/${MARKETPLACE_REPO} agent-avatar-connectors`,
    "cd agent-avatar-connectors",
  ];
  // Windows 上 `python3` 是 0 字节的应用商店存根，所以插件里那句 `python3` 必须先换成
  // 本机解释器的绝对路径。这一步是**一条命令**，不是让 agent 逐字改 JSON ——
  // 后者每次结果都可能不同，而这条链路上的错误是静默的。
  const localize = `python localize.py ${harness}`;

  let steps: string[];
  if (cli) {
    steps = windows
      ? [...clone, localize, `${cli} plugin marketplace add .`, `${cli} plugin install agent-avatar@agent-avatar`]
      : [`${cli} plugin marketplace add ${MARKETPLACE_REPO}`, `${cli} plugin install agent-avatar@agent-avatar`];
  } else if (harness === "dsh") {
    // dsh 没有「插件市场」式的安装命令给本地目录用，装法是往它的用户 patch 层加一条 insert。
    // 那个文件被 dsh 的 HMR 监视着，正在跑的 dsh 会热加载。
    steps = [...clone, ...(windows ? [localize] : []),
      zh ? "把插件目录的绝对路径记下来（plugins/dsh/agent-avatar/index.mjs）"
         : "Note the absolute path of plugins/dsh/agent-avatar/index.mjs",
      zh ? "在 $DSH_HOME/cordis.patch.yml 末尾加一段（先备份），name 用上一步那个路径；Windows 上必须写成 file:/// 开头的 URL，否则 Node 会把盘符当成协议名："
         : "Append this block to $DSH_HOME/cordis.patch.yml (back it up first), with name set to that path. On Windows it must be a file:/// URL, otherwise Node treats the drive letter as a scheme:",
      ["- insert:", "    - id: agent-avatar", "      name: <上一步的路径>"].join("\n")];
  } else {
    // Hermes 是 in-process 的 Python 包，拷进插件目录再启用即可。五家里唯一不需要本地化的。
    steps = [...clone,
      zh ? "用 hermes plugins install <仓库地址> 装（Hermes 自己有插件 CLI，会跑一遍安全扫描）；它的 home 在 Windows 上是 %LOCALAPPDATA%\hermes，不是 ~/.hermes"
         : "Install with hermes plugins install <repo> (Hermes has its own plugin CLI and runs a security scan); its home is %LOCALAPPDATA%\hermes on Windows, not ~/.hermes",
      "hermes plugins enable agent-avatar"];
  }

  const verify = zh
    ? `确认真的通了：跑一轮之后看 ${windows ? "%TEMP%\\" : "$TMPDIR/"}${stateFileName(harness)} 有没有出现、内容会不会随会话变化。**不要只看命令有没有报错** —— hook 的设计是永远 exit 0，退出码说明不了任何事。`
    : `Verify it actually works: after one turn, check that ${windows ? "%TEMP%\\" : "$TMPDIR/"}${stateFileName(harness)} exists and changes as the session moves. **Don't just check that the commands succeeded** — the hook always exits 0 by design, so its exit code proves nothing.`;

  const boundaries = [
    zh ? "如果这台机器上没有可用的 Python，**先问我**再装（Windows: winget install Python.Python.3.13）。"
       : "If this machine has no usable Python, **ask me first** before installing one (Windows: winget install Python.Python.3.13).",
    ...(harness === "codex"
      ? [zh ? "装完之后**不要替我授信**：Codex 的 /hooks 授信必须由我自己点，告诉我该去点什么就行。"
            : "After installing, **do not trust the hooks for me**: the /hooks approval in Codex is mine to click — just tell me what to click."]
      : []),
  ];

  return [
    zh ? `帮我装 Agent Avatar 的 ${harness} connector（一个纯观察者插件：只读事件、写一个本地状态文件，不改变 agent 的行为）。按顺序执行：`
       : `Install the Agent Avatar ${harness} connector for me (a pure observer plugin: it reads events and writes a local state file; it never changes the agent's behaviour). Run these in order:`,
    "",
    ...steps.map((step, index) => `${index + 1}) ${step}`),
    "",
    verify,
    "",
    ...boundaries,
  ].join("\n");
}
