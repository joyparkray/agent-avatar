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
 */

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
