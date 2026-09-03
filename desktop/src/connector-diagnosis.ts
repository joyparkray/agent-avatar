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
 * 口径是「比这个 app 构建时配套的那版旧」。connector 和 app 分开发布，所以用户完全可能
 * 装到一个**比这个常量还新**的 connector —— 那种情况**不提示**，否则等于催他去装一个更旧的。
 *
 * 🔴 **这条口径是权宜，不是原则。** 早先这里写的理由是「app 不下载任何东西所以不联网」——
 * 那是把两件事混成了一件：**查一个版本字符串和下载并执行代码完全不同**，前者没有 MOTW、
 * 没有解压、没有脚本执行，也就没有那条杀软误报链。而且 app 本来就不「自带」connector
 * （它一个字节都不分发），所以「比我自带的旧」这个说法本身就不成立。
 *
 * 正确的做法是去 connector 仓库拉一次版本号（带缓存、离线就安静失败、可关掉），
 * 把这个常量降级成离线兜底。**待做** —— 在那之前，这里的行为就是和常量比。
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

  // 🔴 **两个平台走同一条路：clone → 本地化 → 装成本地 marketplace。**
  //
  // mac 上本来可以更短（`marketplace add owner/repo` 两条命令，还能吃到 harness 的自动更新），
  // 那条路我们跑通过。放弃它换来三件事：
  //
  // 1. **一份提示词、一条路。** 分叉过的两条今天各出过一次错 —— Windows 那条把
  //    `add ./` 写成 `add .`（差一个斜杠整条路就断），更新按钮又把安装那段发了出去
  //    （`git clone` 到一个已存在的目录）。少一个分支就少一类错。
  // 2. **mac 上也会跑冒烟自检。** `localize.py` 要喂一条真事件、验到状态文件落盘才算成功，
  //    于是「这台机器上跑得起来」在两个平台上都有实据，装机记录也都有。
  // 3. **顺带拆掉 mac 上的一颗雷**：Codex 的 POSIX 命令写死 `/usr/bin/python3`，
  //    而干净 Mac 上那是 Xcode 命令行工具的**占位程序** —— 跑它会弹安装对话框。
  //
  // 代价：mac 失去 harness 的自动更新。但更新本来就已经是显式的（Windows 那份收不到自动更新），
  // 而 app 会在版本落后时提示 —— 两个平台因此行为一致，不再是一个悄悄更新、一个不动。
  // 🔴 **clone 的位置要钉死。** 早先这里不带路径，仓库就落在 agent 当时的工作目录里 ——
  // 2026-09-03 实机把提示词交给真实 agent 时，它 clone 进了会话的临时目录，然后自己
  // 提醒我们「这个目录被清理掉插件源就没了」。它是对的，而且比它说的更严重：
  // 本地 marketplace 装出来的插件**是从源目录跑的**（同一轮卸载后删掉该目录，
  // 正在跑的会话立刻报 "Plugin directory does not exist"）。目录一没，connector 就
  // 变成「装着但永远不上报」—— 正是最难查的那一类。
  //
  // `$HOME` 在 bash / zsh / PowerShell 里都成立，所以两个平台仍是同一行字。
  const clone = [
    // 目录已存在是**常态**而不是错误：装第二家时同一份 clone 直接复用。不写这句的话
    // `git clone` 会以 "already exists and is not an empty directory" 失败，能力弱一点的
    // agent 就卡在第一步了（2026-09-03 那次是 agent 自己绕过去的）。
    zh ? `git clone https://github.com/${MARKETPLACE_REPO} "$HOME/agent-avatar-connectors"（目录已经在了就跳过这步，几家共用同一份）`
       : `git clone https://github.com/${MARKETPLACE_REPO} "$HOME/agent-avatar-connectors" (skip this if the directory already exists — the harnesses share one copy)`,
    `cd "$HOME/agent-avatar-connectors"`,
  ];
  // 用哪个名字调 Python **交给 agent 判断**：Windows 上 `python3` 是 0 字节存根，
  // 而 macOS 上通常只有 `python3`。这一处让它判断是安全的 —— 挑错了会立刻失败
  // （存根打印 "Python was not found" 就退出），不会静默走下去。
  // `python` 与 `python3` 的取舍**说一次就够**（放在下面的边界里）。原来每条 localize 步骤
  // 都带一句「macOS/Linux 上通常写 python3」，dsh 那份因此重复了两遍 —— 提示词是给人看的，
  // 同一句话出现两次，读的人会以为那是两件不同的事。
  const localize = (extra = "") => `python localize.py ${harness}${extra}`;

  let steps: string[];
  if (cli && !(windows && harness === "codex")) {
    // `add ./` 而不是 `add .`：实测 `.` 被拒（Invalid marketplace source format，
    // 它要的是 owner/repo、https://… 或 ./path 三种形态之一）。
    steps = [...clone, localize(), `${cli} plugin marketplace add ./`,
             `${cli} plugin install agent-avatar@agent-avatar`];
  } else if (harness === "codex") {
    // 🔴 Windows 的 ChatGPT app **不带 codex CLI**，`codex plugin …` 那两条在这儿根本跑不了。
    // 它的真实登记处是 config.toml，所以让脚本把要加的两段算好、打印出来 ——
    // 仍然是钉死的命令，agent 不需要自己拼路径。**只打印不写**：那是用户自己的主配置文件。
    steps = [...clone, localize(), localize(" --print-registration"),
      zh ? "把上一步打印出来的两段追加到它指出的那个 config.toml 里（先备份）"
         : "Append the two blocks it printed to the config.toml it names (back it up first)",
      zh ? "**完全退出 ChatGPT app 再打开** —— 插件在启动时才被发现，而且 app 运行时也会写 config.toml"
         : "**Fully quit and reopen the ChatGPT app** — plugins are discovered at startup, and the app writes config.toml while running"];
  } else if (harness === "dsh") {
    // dsh 没有「插件市场」式的安装命令给本地目录用，装法是往它的用户 patch 层加一条 insert
    // （那个文件被 dsh 的 HMR 监视着，正在跑的 dsh 会热加载）。
    //
    // 🔴 这一段原来是**三步**：本地化、打印登记段、让 agent 把它粘进 cordis.patch.yml。
    // 那个手工粘贴是五家里最容易出错的一步 —— YAML 缩进敏感、name 必须是 file:/// URL
    // （手拼十有八九写成 `C:/…`，而 Node 会把盘符当协议名）、文件里原有的 `[]` 还得删掉，
    // 而且**粘错了没有任何声音**（dsh 把插件的 stderr 丢弃）。现在脚本自己写，
    // 一条命令就是整个安装。
    steps = [...clone, localize(" --register")];
  } else {
    // Hermes 是唯一的例外：它自己的 CLI 只认 git 来源、支持 `owner/repo/子目录`、
    // 还能钉死 commit SHA —— 它自己就是「钉死的命令」，不需要我们 clone。
    // 而且它不需要本地化（in-process Python 包，跑在 Hermes 自己的解释器里）。
    steps = [`hermes plugins install ${MARKETPLACE_REPO}/plugins/hermes/agent-avatar --enable`,
      // 被拦下时要**把放行命令原样给出来**：用户很可能过一阵才回来点头，那时多半已经是
      // 另一个会话了，而新会话不知道第 1 步那条完整的安装地址（2026-09-03 实机就是这样
      // 失败的：隔了一个会话说「放行」，agent 拿 `hermes plugins install agent-avatar`
      // 去装，报「不在索引里」）。把命令留在对话里，放行就只是复制粘贴。
      zh ? "它会跑一遍安全扫描。**被拦下就停下来告诉我**，让我自己决定要不要放行 —— 别替我加 --force。同时把「放行的话该跑哪条命令」原样写出来（就是上面那条加 --force），我可能过一阵才回来点头。"
         : "It runs a security scan. **If it blocks, stop and tell me** — let me decide whether to override; don't pass --force for me. Also write out the exact command to run if I do approve (the one above plus --force): I may only come back to it later, in a different session.",
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
  // 结论来自 `localize.py` 那一步（它跑完冒烟自检才会打那一行），不是最后一条命令。
  // 两个平台现在都跑它，所以这句不再分平台 —— 只有 Hermes 例外（它不需要本地化，
  // 结论由它自己的 `plugins doctor` 给）。
  // `localize.py` 跑在**装进 harness 之前**，所以它那行只证明「这台机器跑得起来」，
  // 证明不了「harness 收下了」。原来这里写「那一行就是结论」，于是最后一步失败时，
  // agent 仍会把带 "installed" 的那行贴出来 —— 那一行现在也改成了 "ready"。
  // 🔴 **提示词会自己长胖。** 每修一个坑就往后面挂一句，几轮下来正文 5 步、后面跟 4 段说明 ——
  // 每一句都有来历，合在一起却是一堵墙，而它的读者是个刚要装东西的普通用户。
  // 所以固定成三块：**做什么**（编号步骤）、**怎么回话**（一句）、**边界**（要点式）。
  // 新的教训往这三块里合并，不再往末尾追加第四块。
  const report = zh
    ? "做完只回一句话：成功，或者失败卡在第几步。不用贴过程。"
    : "When you are done, reply with one line: it worked, or which step it failed at. No transcript.";

  const next = zh
    ? "（装好后要**开一个新会话**才生效 —— 已经在跑的会话不会加载新插件。）"
    : "(It takes effect in a **new session** — sessions already running will not pick up a new plugin.)";

  const boundaries = [
    // Hermes 那条路不 clone、也不跑 localize.py，这两条对它都不适用。
    ...(harness === "hermes" ? [] : [
      // 两条原本分开的目录说明合成一条：它们讲的是同一个目录的同一件事 ——
      // 位置固定、不可移动、不可删除。分开写的时候，agent 会把「别删」和「别换位置」
      // 当成两条独立约束去分别权衡；合起来它就是一条。
      zh ? "`$HOME/agent-avatar-connectors` 位置固定：插件是从那儿跑的，所以**别删也别挪**。它在你的工作区之外，被沙箱拦住就跟我要一次授权。"
         : "`$HOME/agent-avatar-connectors` is fixed: the plugin runs from there, so **do not delete or relocate it**. It sits outside your workspace — if your sandbox blocks it, ask me to approve.",
      zh ? "`python` 还是 `python3` 你自己判断。没有可用的 Python **先问我**（Windows: winget install Python.Python.3.13；macOS: xcode-select --install）。"
         : "Decide yourself whether it is `python` or `python3` here. If there is no usable Python, **ask me first** (Windows: winget install Python.Python.3.13; macOS: xcode-select --install).",
    ]),
    ...(harness === "codex"
      ? [zh ? "**不要替我授信**：Codex 的 /hooks 授信只能我自己点，告诉我去点什么就行。"
            : "**Do not trust the hooks for me**: the /hooks approval in Codex is mine to click — just tell me what to click."]
      : []),
  ];

  return [
    zh ? `帮我装 Agent Avatar 的 ${harness} connector（纯观察者插件：只读事件、写一个本地状态文件，不改变你的行为）。按顺序执行：`
       : `Install the Agent Avatar ${harness} connector for me (a pure observer plugin: it reads events and writes a local state file; it never changes your behaviour). Run these in order:`,
    "",
    ...steps.map((step, index) => `${index + 1}) ${step}`),
    "",
    `${report} ${next}`,
    "",
    ...boundaries.map(line => `- ${line}`),
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
    // 同样由脚本来删：它认得**没有标记**的旧条目（按旧提示词手工粘贴进去的那种），
    // 而让 agent 照着标记去删的话，那些条目会被漏掉、卸载报成功却还留着。
    steps = [`cd "$HOME/agent-avatar-connectors"`, "python localize.py dsh --unregister"];
  } else {
    // ⚠️ Windows 上 `hermes plugins remove` 只做一半：目录改名后删不掉（git 的 pack 是只读的），
    // 而 config.yaml 里还留着 enabled —— 列表显示启用、实际加载不到。所以要交代收尾。
    // 🔴 收尾这步**不能写成「如果它报错就……」**。2026-09-03 实机：`plugins remove` 报了成功、
    // 插件和目录都真的没了，但 `config.yaml` 的 plugins.enabled 里那一行还在 —— 没有任何
    // 报错去触发那个条件分支，于是 agent 跳过了它。写成「去看一眼，有就删」，它就一定会做。
    steps = ["hermes plugins remove agent-avatar",
      zh ? "去 $HERMES_HOME/config.yaml 看 plugins.enabled 里还有没有 agent-avatar 那一行（Windows 上通常还在），有就删掉"
         : "Check plugins.enabled in $HERMES_HOME/config.yaml for an agent-avatar line (on Windows it is usually still there) and remove it if present",
      zh ? "去 plugins 目录看有没有 .agent-avatar.remove-* 残留，有就删掉（先去掉只读属性）"
         : "Check the plugins directory for a leftover .agent-avatar.remove-* and delete it if present (clear the read-only attribute first)"];
  }

  // 判据要**可核对**，而且是问 harness 自己 —— 它才知道自己还认不认这个插件。
  // dsh 没有插件列表命令，只能回去看那个 patch 文件。
  const listCommand = cli ? `${cli} plugin list` : (harness === "hermes" ? "hermes plugins list" : null);
  const verdictCheck = listCommand
    ? (zh ? `判据：跑 \`${listCommand}\`，里面**没有** agent-avatar 就算卸干净了。`
          : `The check: run \`${listCommand}\` — no agent-avatar in the list means it is gone.`)
    : (zh ? "判据：$DSH_HOME/cordis.patch.yml 里**没有** agent-avatar 那一段就算卸干净了。"
          : "The check: no agent-avatar block left in $DSH_HOME/cordis.patch.yml means it is gone.");

  return [
    zh ? `帮我卸载 Agent Avatar 的 ${harness} connector。执行：`
       : `Uninstall the Agent Avatar ${harness} connector for me. Run:`,
    "",
    ...steps.map((step, index) => `${index + 1}) ${step}`),
    "",
    // 与安装提示词同一个形状：步骤 / 一句汇报要求（含判据）/ 要点式边界。
    // 两边口径不一致的话，同一个 agent 在装和卸时会给出两种粒度的回话。
    //
    // 🔴 判据不能省。卸载有好几步，有的会半路失败、有的本来就该跳过，
    // 所以「成功还是失败」本身是个没法回答的问题 —— 2026-09-03 实机，Hermes 那次的
    // 原话是「调用成功，插件已卸载。」紧接着一句「失败。」，两句都对
    // （第 1 步成了、收尾没成），拼在一起对小白就是天书。
    (zh ? "做完只回一句话：成功，或者失败卡在第几步。不用贴过程。"
        : "When you are done, reply with one line: it worked, or which step it failed at. No transcript.")
      + " " + verdictCheck,
    "",
    // 🔴 **这个目录可能是几家共用的。** 路径钉死之后，装第二家时同一份 clone 会被复用
    // （claude-code 和 workbuddy 实机就是共用的）。原来这里直接让 agent 删掉它 ——
    // 那会把还装着的另外几家**静默**弄废：账本上还写着已安装，插件却再也跑不起来。
    // 那次是 agent 自己起疑停下来问才没删成，靠的是运气不是设计。
    // Hermes 从 git 直装，没有这个目录，那条 SessionEnd 红字也只出现在本地 marketplace 这条路上。
    ...(harness === "hermes" ? [] : [
      zh ? "- `$HOME/agent-avatar-connectors`：只有在你没给别的 agent 装过 Agent Avatar 时才删，**不确定就留着**（几家共用同一份）。"
         : "- `$HOME/agent-avatar-connectors`: delete it only if no other agent has Agent Avatar installed — **if unsure, leave it** (the harnesses share one copy).",
      zh ? "- 当前会话结束时可能会报一句 “Plugin directory does not exist”，那是正常的（插件已经在内存里了），忽略即可。"
         : "- This session may print \"Plugin directory does not exist\" when it ends; that is expected (the plugin is already in memory), ignore it.",
    ]),
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

  if (harness !== "hermes") {
    // 装机记录里的 source 指到插件树（<clone>/plugins/<harness>/agent-avatar），
    // 往上三层才是仓库根。拿不到就让 agent 去找 —— 但先给出它长什么样。
    const root = clonePath?.replace(/[\/]plugins[\/][^\/]+[\/]agent-avatar[\/]?$/, "");
    steps.push(root
      ? `cd ${root}`
      : (zh ? "进到当初 clone 出来的 agent-avatar-connectors 目录" : "cd into the agent-avatar-connectors directory you cloned earlier"));
    steps.push("git pull");
    steps.push(zh ? `用这台机器上的 Python 跑：python localize.py ${harness}（macOS/Linux 上通常写 python3）`
                  : `Run with this machine's Python: python localize.py ${harness} (usually python3 on macOS/Linux)`);
  }

  if (cli) {
    // 先卸再装：装同一个插件名时 CLI 只会说「已安装」，**不会刷新缓存里那份副本**。
    // 远程 marketplace 那条路 install 会先刷新市场，所以不必单独 update。
    // 先卸再装：装同一个插件名时 CLI 只会说「已安装」，**不会刷新缓存里那份副本**。
    steps.push(`${cli} plugin uninstall agent-avatar`);
    steps.push(`${cli} plugin install agent-avatar@agent-avatar`);
  } else if (harness === "dsh") {
    // 重新登记是幂等的（脚本先删旧条目再写新的），所以更新不需要单独一步去核对路径。
    steps.push("python localize.py dsh --register");
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
