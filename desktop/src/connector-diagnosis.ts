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

/**
 * 该不该提示更新 connector。
 *
 * 🔴 **口径是「比这个 app 自带的那版旧」，不是「比 GitHub 上最新的旧」** ——
 * app 不联网（那是刻意的：不下载任何东西，见模块头）。它唯一知道的「新」就是自己
 * 构建时配套的那个版本号。connector 和 app 分开发布，所以用户完全可能装到一个**比 app 还新**
 * 的 connector —— 那种情况**不提示**，否则等于催他去装一个更旧的。
 *
 * 没上报过版本的（旧 connector 根本不写这个字段）算旧：那种恰恰最该更新。
 */
export function isOutdated(reported: string | null | undefined): boolean {
  // 字段缺失 = 旧 connector（它们根本不写这个字段），那种恰恰最该更新
  if (!reported) return true;
  if (reported === CONNECTOR_VERSION) return false;
  // 读不懂的版本串**不提示**：可能是将来的新命名，也可能是文件坏了 ——
  // 两种情况催更新都是错的。真坏了自有诊断那条路去说。
  if (!/^\d/.test(reported.trim())) return false;
  return compareVersions(reported, CONNECTOR_VERSION) < 0;
}

/** 逐段比数字的版本比较。段里读不出数字就按 0 算（`1.0.0-rc1` 的 `0-rc1` 那种）。 */
function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map(part => Number.parseInt(part, 10) || 0);
  const a = parse(left), b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
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
  if (cli && !(windows && harness === "codex")) {
    steps = windows
      // `add ./` 而不是 `add .`：实测 `.` 被拒（Invalid marketplace source format，
      // 它要的是 owner/repo、https://… 或 ./path 三种形态之一）。差一个斜杠，整条路就断了。
      ? [...clone, localize, `${cli} plugin marketplace add ./`, `${cli} plugin install agent-avatar@agent-avatar`]
      : [`${cli} plugin marketplace add ${MARKETPLACE_REPO}`, `${cli} plugin install agent-avatar@agent-avatar`];
  } else if (harness === "codex") {
    // 🔴 Windows 的 ChatGPT app **不带 codex CLI**，`codex plugin …` 那两条在这儿根本跑不了。
    // 它的真实登记处是 config.toml，所以让脚本把要加的两段算好、打印出来 ——
    // 仍然是钉死的命令，agent 不需要自己拼路径。**只打印不写**：那是用户自己的主配置文件。
    steps = [...clone, localize, `python localize.py codex --print-registration`,
      zh ? "把上一步打印出来的两段追加到它指出的那个 config.toml 里（先备份）"
         : "Append the two blocks it printed to the config.toml it names (back it up first)",
      zh ? "**完全退出 ChatGPT app 再打开** —— 插件在启动时才被发现，而且 app 运行时也会写 config.toml"
         : "**Fully quit and reopen the ChatGPT app** — plugins are discovered at startup, and the app writes config.toml while running"];
  } else if (harness === "dsh") {
    // dsh 没有「插件市场」式的安装命令给本地目录用，装法是往它的用户 patch 层加一条 insert。
    // 那个文件被 dsh 的 HMR 监视着，正在跑的 dsh 会热加载。
    // 同样让脚本把那一段算好 —— Windows 上 name 必须是 file:/// URL，
    // 手拼的话十有八九会写成 `C:/…`，而 Node 会把盘符当成协议名。
    steps = [...clone, ...(windows ? [localize] : []), `python localize.py dsh --print-registration`,
      zh ? "把上一步打印出来的那一段追加到它指出的 cordis.patch.yml 里（先备份）"
         : "Append the block it printed to the cordis.patch.yml it names (back it up first)"];
  } else {
    // Hermes 有自己的插件 CLI，只认 git 来源，还能钉死 commit SHA。
    // 它装完会跑一遍安全扫描 —— 被拦下时**由用户决定**要不要放行，不要替他 --force。
    // Hermes 只认 git 来源，但支持 `owner/repo/子目录` —— 我们的插件在树里的
    // plugins/hermes/agent-avatar 下，所以要带上那一段路径。
    steps = [`hermes plugins install ${MARKETPLACE_REPO}/plugins/hermes/agent-avatar --enable`,
      zh ? "它会跑一遍安全扫描。**被拦下就停下来告诉我**，让我自己决定要不要放行 —— 别替我加 --force。"
         : "It runs a security scan. **If it blocks, stop and tell me** — let me decide whether to override; don't pass --force for me.",
      "hermes plugins doctor agent-avatar"];
  }

  // 🔴 **只说结论，不要展示证明过程。**
  //
  // 原来这里写的是「不要只看命令有没有报错 —— hook 永远 exit 0，退出码说明不了任何事，
  // 你去看状态文件」。那是写给开发者的认识论，而且等于向 agent 下战书：一个称职的 agent
  // 会真去证明给你看 —— 三条独立证据、md5、排除假阳性（2026-09-03 实机就是这样）。
  // 它做得没错，是我们要错了东西：**装 connector 的用户多半不是开发者**，
  // 那一大段只会让他犯嘀咕「到底成了没有」。
  //
  // 验证照做（`localize.py` 装机时就喂过一条真事件、验到状态文件落盘），但**结论由命令
  // 给出**，agent 只负责转述那一行。真出问题时它自然会带着上下文来找你，
  // 而详细信息就在那条命令的前几行。
  // Windows 上结论来自 `localize.py` 那一步（它跑完冒烟自检才会打那一行），不是最后一条命令。
  const verdictStep = windows && harness !== "hermes"
    ? (zh ? `（\`localize.py ${harness}\` 那一步的最后一行就是结论，原样贴过来即可）`
          : ` (the last line of the \`localize.py ${harness}\` step is the verdict — paste it verbatim)`)
    : "";
  const report = zh
    ? `**只告诉我成功还是失败**；失败的话说清卡在哪一步。不用解释你是怎么验证的，也不用贴中间过程。${verdictStep}`
    : `**Just tell me whether it worked**, and if not, which step it stopped at. No explanation of how you verified it, no intermediate output.${verdictStep}`;

  const next = zh
    ? "装好之后开一个新会话，形象就会跟着动 —— 已经在跑的会话不会加载新插件。"
    : "Start a new session afterwards and the avatar will follow along — a session that is already running will not pick up a new plugin.";

  const boundaries = [
    // 装 Python 这类事要用户点头；给的命令也得是这台机器上真能跑的那条
    zh ? `如果这台机器上没有可用的 Python，**先问我**再装（${windows ? "winget install Python.Python.3.13" : "macOS: xcode-select --install"}）。`
       : `If this machine has no usable Python, **ask me first** before installing one (${windows ? "winget install Python.Python.3.13" : "macOS: xcode-select --install"}).`,
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
    report,
    next,
    "",
    ...boundaries,
  ].join("\n");
}

/**
 * 卸载 connector 的提示词 —— 和安装同一条路：交给 agent。
 *
 * 🔴 **为什么 app 自己不做这件事**：卸载要动的是 harness 自己的账本（`plugin uninstall`
 * 会同时清登记和缓存副本），而**它的布局我们一天之内追丢过三次** ——
 * claude-code / codex 改成本地 marketplace、Hermes 在 Windows 上不住 `~/.hermes`，
 * 以及 app 里那个卸载按钮对「从远程 marketplace 装」的那套完全没用（它删的两个目录都不存在，
 * 于是删掉零个文件、报告成功，而账本原封不动 —— 正是我们一整天在打的那个形状）。
 *
 * 装是 harness 干的，卸也该由它干。它自己最清楚东西在哪。
 */
export function uninstallPrompt(harness: string, locale: Language): string {
  const zh = locale !== "en";
  const cli = MARKETPLACE_CLI[harness];
  let steps: string[];
  if (cli) {
    // `marketplace remove` 会连带清掉缓存里那份插件副本 —— 只 uninstall 会留下市场登记，
    // 下次装同名插件时它还在，容易装到旧版上。
    steps = [`${cli} plugin uninstall agent-avatar`, `${cli} plugin marketplace remove agent-avatar`];
  } else if (harness === "dsh") {
    steps = [zh ? "从 $DSH_HOME/cordis.patch.yml 里删掉 `# >>> agent-avatar (managed) >>>` 到 `# <<< agent-avatar (managed) <<<` 之间那一段（含这两行），其余原样保留"
                : "Delete the block between `# >>> agent-avatar (managed) >>>` and `# <<< agent-avatar (managed) <<<` (inclusive) from $DSH_HOME/cordis.patch.yml, leaving everything else untouched"];
  } else {
    // ⚠️ Windows 上 `hermes plugins remove` 只做一半：目录改名后删不掉（git 的 pack 是只读的），
    // 而 config.yaml 里还留着 enabled —— 列表显示启用、实际加载不到。所以要交代收尾。
    steps = ["hermes plugins remove agent-avatar",
      zh ? "如果它报错没删干净（Windows 上会）：从 $HERMES_HOME/config.yaml 的 plugins.enabled 里删掉 agent-avatar 那一行，再删掉 plugins 目录下那个 .agent-avatar.remove-* 残留（先去掉只读属性）"
         : "If it errors out half-way (it does on Windows): remove the agent-avatar line from plugins.enabled in $HERMES_HOME/config.yaml, then delete the leftover .agent-avatar.remove-* under plugins (clear the read-only attribute first)"];
  }
  return [
    zh ? `帮我卸载 Agent Avatar 的 ${harness} connector。执行：`
       : `Uninstall the Agent Avatar ${harness} connector for me. Run:`,
    "",
    ...steps.map((step, index) => `${index + 1}) ${step}`),
    "",
    zh ? "如果之前是 clone 到本地装的（Windows 那条路），把那个 agent-avatar-connectors 目录也删掉。"
       : "If it was installed from a local clone (the Windows route), delete that agent-avatar-connectors directory too.",
    zh ? "**只告诉我成功还是失败。** 不用解释过程。"
       : "**Just tell me whether it worked.** No explanation needed.",
  ].join("\n");
}

/**
 * 更新 connector 的提示词。
 *
 * 🔴 **不能复用安装那段**：Windows 那条路第一步是 `git clone`，而目录已经存在 ——
 * agent 一跑就失败（2026-09-03 发现时，「复制更新提示词」按钮给的正是安装那段）。
 * 更新要做的是 `git pull` + 重新本地化 + 重装，三件事都和首装不同。
 *
 * `clonePath` 来自装机记录里的 `source`（`localize.py` 写的那份）——
 * 有它就能直接 `cd` 过去，agent 不用猜用户当初把仓库 clone 到哪儿了。
 */
export function updatePrompt(harness: string, locale: Language, platform: Platform = currentPlatform(),
                             clonePath?: string | null): string {
  const zh = locale !== "en";
  const cli = MARKETPLACE_CLI[harness];
  const windows = platform === "windows";
  const steps: string[] = [];

  if (windows && harness !== "hermes") {
    // 装机记录里的 source 指到插件树（<clone>/plugins/<harness>/agent-avatar），
    // 往上三层才是仓库根。拿不到就让 agent 去找 —— 但先给出它长什么样。
    const root = clonePath?.replace(/[\/]plugins[\/][^\/]+[\/]agent-avatar[\/]?$/, "");
    steps.push(root
      ? `cd ${root}`
      : (zh ? "进到当初 clone 出来的 agent-avatar-connectors 目录" : "cd into the agent-avatar-connectors directory you cloned earlier"));
    steps.push("git pull");
    steps.push(`python localize.py ${harness}`);
  }

  if (cli) {
    // 先卸再装：装同一个插件名时 CLI 只会说「已安装」，**不会刷新缓存里那份副本**。
    // 远程 marketplace 那条路 install 会先刷新市场，所以不必单独 update。
    steps.push(`${cli} plugin uninstall agent-avatar`);
    steps.push(windows ? `${cli} plugin install agent-avatar@agent-avatar`
                       : `${cli} plugin marketplace update agent-avatar`);
    if (!windows) steps.push(`${cli} plugin install agent-avatar@agent-avatar`);
  } else if (harness === "dsh") {
    steps.push(zh ? "确认 $DSH_HOME/cordis.patch.yml 里那一段还指向同一个路径（一般不用改）"
                  : "Check that the block in $DSH_HOME/cordis.patch.yml still points at the same path (usually unchanged)");
  } else {
    steps.push(`hermes plugins install ${MARKETPLACE_REPO}/plugins/hermes/agent-avatar --enable --force`,
      "hermes plugins doctor agent-avatar", "hermes gateway restart");
  }

  return [
    zh ? `帮我把 Agent Avatar 的 ${harness} connector 更新到最新版。执行：`
       : `Update the Agent Avatar ${harness} connector to the latest version. Run:`,
    "",
    ...steps.map((step, index) => `${index + 1}) ${step}`),
    "",
    zh ? "**只告诉我成功还是失败。** 更新后开一个新会话才会生效。"
       : "**Just tell me whether it worked.** It takes effect in a new session.",
    ...(harness === "codex"
      ? [zh ? "⚠️ 更新后 **hooks 要重新授信**（Codex 按 hook 的内容哈希记忆信任）—— 那一步我自己点，你告诉我去点什么就行。"
            : "⚠️ After an update the **hooks must be trusted again** (Codex keys trust to the hook's content hash) — that step is mine to click; just tell me what to click."]
      : []),
  ].join("\n");
}
