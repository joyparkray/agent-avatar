import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONNECTOR_VERSION, diagnosePrompt, diagnosisReasons, installPrompt, isOutdated, MARKETPLACE_REPO, stateFileName, uninstallPrompt, updatePrompt } from "./connector-diagnosis";
import { CONNECTOR_HARNESSES, CONNECTOR_TEXT, freshness, HARNESS_LABELS, linkState, postInstallSteps, statusLabel } from "./connectors";

describe("connector install wizard", () => {
  it("covers exactly the five harnesses the Rust side whitelists", () => {
    // 两侧各写一份名单必然会漂，而漂了之后表现是「界面上有这家、点安装说 unknown harness」
    const rust = readFileSync("src-tauri/src/connectors.rs", "utf8");
    const listed = rust.match(/HARNESSES: \[&str; 5\] = \[(.+?)\]/)![1]
      .split(",").map(item => item.trim().replace(/"/g, ""));
    expect([...CONNECTOR_HARNESSES].sort()).toEqual(listed.sort());
    for (const harness of CONNECTOR_HARNESSES) expect(HARNESS_LABELS[harness]).toBeTruthy();
  });

  it("keeps both languages in sync", () => {
    expect(Object.keys(CONNECTOR_TEXT.en).sort()).toEqual(Object.keys(CONNECTOR_TEXT["zh-CN"]).sort());
  });

  it("spells out the manual step each harness still needs", () => {
    // 装完「没反应」时用户唯一的线索就是这段文字，缺一条就等于静默失败
    for (const locale of ["zh-CN", "en"] as const) {
      expect(postInstallSteps("codex", locale).join("\n")).toContain("/hooks");
      // Codex 按内容哈希记忆信任：升级 connector 之后必须重新授信，不说的话表现是「升级后失灵」
      expect(postInstallSteps("codex", locale).length).toBe(2);
      expect(postInstallSteps("hermes", locale).join("\n")).toContain("hermes plugins enable agent-avatar");
      expect(postInstallSteps("workbuddy", locale).join("\n")).toMatch(/重启|Restart/);
      // 这两家装完即用，别造一条假的「还要做点什么」
      expect(postInstallSteps("claude-code", locale)).toEqual([]);
      expect(postInstallSteps("dsh", locale)).toEqual([]);
    }
    expect(postInstallSteps("unknown", "en")).toEqual([]);
  });

  it("names the antivirus as a possible cause for every harness", () => {
    // 2026-09-02 实机：卡巴斯基把安装脚本判成 PDM:Trojan.Win32.Generic 并**直接删除**。
    // 文件没了之后界面上只表现为「装了但不动」—— 不写出来，普通用户永远想不到去看隔离区。
    for (const locale of ["zh-CN", "en"] as const) {
      for (const harness of CONNECTOR_HARNESSES) {
        const reasons = diagnosisReasons(harness, locale).join(" | ");
        expect(reasons).toMatch(/杀毒软件|antivirus/);
        expect(reasons).toContain("PDM:Trojan.Win32.Generic");
        // 缺 Python 是另一条用户无从下手的：Windows 上 python3 是 0 字节的商店占位程序
        expect(reasons).toMatch(/Python/);
      }
    }
  });

  it("puts each harness's own most likely cause first", () => {
    // 顺序即概率：用户多半只看头一条，所以那一条必须是这家真正最常见的原因
    expect(diagnosisReasons("codex", "zh-CN")[0]).toContain("授信");
    expect(diagnosisReasons("codex", "en")[0]).toContain("trusted");
    expect(diagnosisReasons("claude-code", "zh-CN")[0]).toContain("claude plugin list");
    expect(diagnosisReasons("workbuddy", "zh-CN")[0]).toMatch(/重启/);
    expect(diagnosisReasons("dsh", "zh-CN")[0]).toContain("cordis.patch.yml");
    expect(diagnosisReasons("hermes", "zh-CN")[0]).toContain("hermes plugins enable agent-avatar");
    // 认不出的 harness 也不能一条都不给 —— 共用的三条仍然适用
    expect(diagnosisReasons("unknown", "en").length).toBeGreaterThan(0);
  });

  it("hands the agent pinned commands, not a treasure hunt", () => {
    // 🔴 方案 5 的边界：提示词会被复制、转发、改写。只有当它退化成「执行这几条确定的
    // 命令」时，用户和我们才都能确认它做了什么。
    for (const locale of ["zh-CN", "en"] as const) {
      for (const harness of CONNECTOR_HARNESSES) {
        const prompt = diagnosePrompt(harness, locale);
        expect(prompt).toContain(stateFileName(harness));       // 查哪个文件，说死
        expect(prompt).toContain("PDM:Trojan.Win32.Generic");   // 隔离区那条线索
        expect(prompt).toContain("import sys; print(sys.executable)");
        // 排查不等于修复：修复里有些步骤（Codex 的 /hooks 授信）只能由人来点
        expect(prompt).toMatch(/不要改任何配置|Don't change any configuration/);
      }
    }
    expect(diagnosePrompt("claude-code", "en")).toContain("claude plugin list");
    expect(diagnosePrompt("workbuddy", "en")).toContain("codebuddy plugin list");
    expect(diagnosePrompt("codex", "en")).toContain("config.toml");
  });

  it("keeps Hermes on the unsuffixed state file it has always used", () => {
    // 已经装好的 Hermes 用户不该因为我们给别家加后缀就断掉
    expect(stateFileName("hermes")).toBe("agent-avatar-state.json");
    expect(stateFileName("claude-code")).toBe("agent-avatar-state.claude-code.json");
  });

  it("points the install prompt at the same repo the build script publishes", () => {
    // 两处各写一份必然会漂，而漂了之后表现是「照提示词跑完，装的是另一个仓库」
    const script = readFileSync("../connectors/build-marketplace.sh", "utf8");
    expect(script).toContain(`REPO=${MARKETPLACE_REPO}`);
    for (const harness of CONNECTOR_HARNESSES) {
      expect(installPrompt(harness, "zh-CN", "posix")).toContain(MARKETPLACE_REPO);
    }
  });

  it("agrees with the core about what version connectors report", () => {
    // connector 把版本写进每一次状态快照，app 拿它判断该不该提示更新。
    // 两边对不上的话，用户会被告知一个错误的版本号 —— 或者永远被提示「该更新了」。
    const core = readFileSync("../bridge/state_machine.py", "utf8");
    expect(core).toContain(`CONNECTOR_VERSION = "${CONNECTOR_VERSION}"`);
    // 五家的清单也必须是同一个版本（build-marketplace.sh 会逐个对，这里守住其中一份）
    const manifest = readFileSync("../connectors/claude-code/plugin/agent-avatar/.claude-plugin/plugin.json", "utf8");
    expect(JSON.parse(manifest).version).toBe(CONNECTOR_VERSION);
  });

  it("asks the agent for a verdict, not for a proof", () => {
    // 2026-09-03 实机：提示词原来在这儿解释「hook 永远 exit 0、退出码说明不了任何事、
    // 你去看状态文件」—— 那是写给开发者的认识论，等于向 agent 下战书。
    // 它照做了：三条独立证据、md5、排除假阳性。做得没错，但**装 connector 的用户
    // 多半不是开发者**，那一大段只会让他犯嘀咕「到底成了没有」。
    for (const locale of ["zh-CN", "en"] as const) {
      for (const harness of CONNECTOR_HARNESSES) {
        for (const platform of ["windows", "posix"] as const) {
          const prompt = installPrompt(harness, locale, platform);
          // 不再要求 agent 自己去证明
          expect(prompt).not.toContain(stateFileName(harness));
          expect(prompt).not.toMatch(/永远 exit 0|always exits 0/);
          // 改成明确要求「只报结论」
          expect(prompt).toMatch(/只回一句|reply with one line/i);
          expect(prompt).toMatch(/不用贴过程|No transcript/i);
          // 下一步仍然要说 —— 否则用户装完会以为没生效
          expect(prompt).toMatch(/新会话|new session/i);
        }
      }
    }
  });

  it("never tells a user who is ahead to update", () => {
    // app 不联网，它唯一知道的「新」就是自己构建时配套的版本。connector 和 app 分开发布，
    // 所以用户完全可能装到比 app 还新的 —— 那时候提示更新等于催他装一个更旧的。
    expect(isOutdated("0.9.0")).toBe(true);
    expect(isOutdated(CONNECTOR_VERSION)).toBe(false);
    expect(isOutdated("99.0.0")).toBe(false);
    expect(isOutdated("1.0.1")).toBe(false);
    // 没上报版本的（旧 connector 根本不写这个字段）恰恰最该更新
    expect(isOutdated(null)).toBe(true);
    // 认不出的版本串不该催错方向
    expect(isOutdated("weird")).toBe(false);
  });

  it("updates with a pull, not a clone", () => {
    // 🔴 2026-09-03 发现：「复制更新提示词」那个按钮给的是**安装**那段，
    // 而它第一步是 git clone —— 目录已经存在，agent 一跑就失败。
    const clone = "C:/Users/x/agent-avatar-connectors/plugins/claude-code/agent-avatar";
    const windows = updatePrompt("claude-code", "zh-CN", "windows", clone);
    expect(windows).toContain("git pull");
    expect(windows).not.toContain("git clone");
    // 装机记录里的 source 指到插件树，往上三层才是仓库根 —— agent 不用猜
    expect(windows).toContain("cd C:/Users/x/agent-avatar-connectors");
    expect(windows).toContain("python localize.py claude-code");
    // 先卸再装：同名插件 install 只会说「已安装」，不刷新缓存里那份副本
    expect(windows.indexOf("plugin uninstall")).toBeLessThan(windows.indexOf("plugin install"));
    // 没有装机记录时不能编一个路径出来
    expect(updatePrompt("claude-code", "zh-CN", "windows")).not.toContain("cd undefined");
    // mac 现在走同一条：也 pull、也本地化
    const posix = updatePrompt("claude-code", "zh-CN", "posix", clone);
    expect(posix).toBe(windows);
    // Codex 升级后必须重新授信 —— 不说的话表现是「升级后失灵」
    expect(updatePrompt("codex", "zh-CN", "posix")).toMatch(/重新授信/);
  });

  it("hands uninstall to the harness's own CLI", () => {
    // app 那个卸载按钮曾经删掉零个文件却报告成功（2026-09-03 实测）——
    // 因为插件实际在 harness 的缓存里，而我们删的是自己猜的目录。
    for (const locale of ["zh-CN", "en"] as const) {
      expect(uninstallPrompt("claude-code", locale)).toContain("claude plugin uninstall agent-avatar");
      // 只 uninstall 会留下市场登记，下次装同名插件容易装到旧版上
      expect(uninstallPrompt("claude-code", locale)).toContain("marketplace remove");
      expect(uninstallPrompt("workbuddy", locale)).toContain("codebuddy plugin uninstall");
      expect(uninstallPrompt("dsh", locale)).toContain("cordis.patch.yml");
      // `plugins remove` 单独跑会把条目留在 config.yaml 的 plugins.enabled 里 ——
      // 列表说启用、实际加载不到。先 disable 才干净，而顺序错了就没有意义。
      const hermes = uninstallPrompt("hermes", locale);
      expect(hermes.indexOf("plugins disable")).toBeGreaterThan(-1);
      expect(hermes.indexOf("plugins disable")).toBeLessThan(hermes.indexOf("plugins remove"));
      // 交代它去编辑 YAML 就等于给了它一个开放任务：实机那次 agent 在这上面跑偏，
      // 连第 1 步都没执行。而且 Windows 上 HERMES_HOME 根本没设。
      expect(hermes).not.toMatch(/HERMES_HOME|config\.yaml/);
    }
  });

  it("uninstalls by the same name it installed by", () => {
    // 短名在 WorkBuddy 上失败（`Marketplace undefined is not found.`）而插件留在原地。
    // 那次看起来成功是因为下一步删 marketplace 顺带带走了它 —— 靠副作用卸载迟早会漏。
    for (const harness of ["claude-code", "workbuddy", "codex"]) {
      const prompt = uninstallPrompt(harness, "zh-CN");
      expect(prompt).toMatch(/plugin uninstall agent-avatar@agent-avatar/);
    }
  });

  it("does not accuse a fresh install of being broken", () => {
    // 「装了但从没上报」在刚装完的几分钟里是**正常的**（还没开新会话），过了一天才是故障。
    // 两者给同一段排查清单，等于告诉刚装完的人「你可能哪儿都错了」——而他什么都没做错。
    const zh = CONNECTOR_TEXT["zh-CN"];
    expect(zh["diagnosis.fresh"]).toMatch(/新会话/);
    expect(zh["diagnosis.freshVerified"]).toMatch(/自检/);
    // 三句话必须各不相同，否则这个区分在界面上根本看不出来
    expect(new Set([zh["diagnosis.title"], zh["diagnosis.fresh"], zh["diagnosis.freshVerified"]]).size).toBe(3);
    for (const key of ["diagnosis.fresh", "diagnosis.freshVerified"]) {
      expect(CONNECTOR_TEXT.en[key]).toBeTruthy();
      // 刚装完那两句里不该出现「杀软删了文件」这类猜测 —— 那是给真卡住的人的
      expect(CONNECTOR_TEXT.en[key]).not.toMatch(/antivirus|quarantine/i);
    }
  });

  it("treats a connector that reports nothing as outdated", () => {
    // 旧版 connector 根本不写这个字段。把它当成「最新」的话，装着老版本的用户
    // 永远不会被告知该更新 —— 而 Windows 上那份收不到 harness 的自动更新。
    expect(isOutdated(null)).toBe(true);
    expect(isOutdated(undefined)).toBe(true);
    expect(isOutdated("0.9.0")).toBe(true);
    expect(isOutdated(CONNECTOR_VERSION)).toBe(false);
  });

  it("gives both platforms the same shape", () => {
    // 分叉过的两条路今天各出过一次错（`add .` 少个斜杠、更新按钮发的是安装那段）。
    // 现在两个平台走同一条：clone → 本地化 → 装成本地 marketplace。
    for (const harness of ["claude-code", "workbuddy", "dsh"]) {
      const windows = installPrompt(harness, "zh-CN", "windows");
      const posix = installPrompt(harness, "zh-CN", "posix");
      expect(windows).toBe(posix);                       // 逐字一致
      expect(posix).toContain("git clone");
      expect(posix).toContain(`localize.py ${harness}`); // mac 上也本地化：顺带拆掉 CLT 占位程序那颗雷
    }
    // 🔴 Codex 是**真实差异**，不是我们没统一：Windows 的 ChatGPT app 不带 codex CLI，
    // 那两条命令在那儿根本跑不了，只能手工登记进 config.toml。
    expect(installPrompt("codex", "zh-CN", "posix")).toContain("codex plugin marketplace add ./");
    expect(installPrompt("codex", "zh-CN", "windows")).not.toContain("codex plugin");
    expect(installPrompt("codex", "zh-CN", "windows")).toContain("--print-registration");
    // Hermes 是唯一的例外：它自己的 CLI 只认 git 来源，而且不需要本地化
    // （in-process Python 包，跑在 Hermes 自己的解释器里）
    const hermes = installPrompt("hermes", "zh-CN", "posix");
    expect(hermes).not.toContain("git clone");
    expect(hermes).not.toContain("localize.py");
    expect(hermes).toContain("hermes plugins install");
  });

  it("lets the agent pick the Python name, because picking wrong fails loudly", () => {
    // 这一处交给 agent 判断是安全的：Windows 上 `python3` 是 0 字节存根、macOS 上通常只有
    // `python3`，而挑错了会**立刻失败**（存根打印 "Python was not found" 就退出），
    // 不会静默走下去 —— 与那些一旦猜错就静默失效的地方（解释器路径、file:/// URL）性质不同。
    for (const locale of ["zh-CN", "en"] as const) {
      const prompt = installPrompt("claude-code", locale, "windows");
      expect(prompt).toMatch(/python3/);                 // 提到另一个名字
      expect(prompt).toMatch(/macOS|Linux/);
    }
  });

  it("uses the path form the CLI actually accepts — where there is a CLI at all", () => {
    // 实测：`claude plugin marketplace add .` 被拒 —— Invalid marketplace source format，
    // 它要 owner/repo、https://… 或 **./path**。差一个斜杠整条路就断了，
    // 而这种错只有真跑一遍才发现得了。
    for (const harness of ["claude-code", "workbuddy"]) {
      const windows = installPrompt(harness, "zh-CN", "windows");
      expect(windows).toContain("plugin marketplace add ./");
      expect(windows).not.toMatch(/marketplace add \.$/m);
    }
    // 🔴 Codex 在 Windows 上**没有 CLI**（ChatGPT app 不带），所以那两条命令在这儿根本
    // 跑不了 —— 它的真实登记处是 config.toml。提示词里出现 `codex plugin` 就是把用户送进死路。
    const codexWindows = installPrompt("codex", "zh-CN", "windows");
    expect(codexWindows).not.toContain("codex plugin");
    expect(codexWindows).toContain("--print-registration");
    expect(codexWindows).toContain("config.toml");
    // POSIX 上有 CLI，走正常那条
    expect(installPrompt("codex", "zh-CN", "posix")).toContain("codex plugin marketplace add");
  });

  it("does not let the agent hand-write the fiddly bits", () => {
    // dsh 的 name 在 Windows 上**必须是 file:/// URL**（Node 会把 `C:/…` 的盘符当协议名，
    // 报 ERR_UNSUPPORTED_ESM_URL_SCHEME）。让模型自己拼十有八九拼错，而错了是静默的。
    // 2026-09-03：原来这里是「脚本打印那一段、你把它粘进 cordis.patch.yml」。
    // 粘贴本身就是 agent 在手写那些讲究的东西 —— 而且粘错了没有任何声音
    // （dsh 把插件的 stderr 丢弃）。现在脚本自己写那个文件。
    for (const platform of ["windows", "posix"] as const) {
      const dsh = installPrompt("dsh", "zh-CN", platform);
      expect(dsh).toContain("localize.py dsh --register");
      expect(dsh).not.toMatch(/追加|Append|粘/);
    }
    // Hermes 的扫描器会拦（sudo 那条误报）——**放不放行是用户的决定**，不能让 agent 代按
    const hermes = installPrompt("hermes", "zh-CN", "posix");
    expect(hermes).toContain("hermes plugins install");
    expect(hermes).toMatch(/别替我加 --force|don't pass --force/i);
    expect(hermes).toContain("hermes plugins doctor");
  });

  it("keeps the human steps human", () => {
    // 授信这类步骤存在的意义就是「让人看一眼再点头」，让 agent 代做等于把这道防线拆了
    for (const locale of ["zh-CN", "en"] as const) {
      const codex = installPrompt("codex", locale, "posix");
      expect(codex).toMatch(/不要替我授信|do not trust the hooks for me/i);
      // 在别人机器上装软件应当由机器的主人点头
      for (const harness of CONNECTOR_HARNESSES.filter(name => name !== "hermes")) {
        expect(installPrompt(harness, locale, "windows")).toMatch(/先问我|ask me first/i);
      }
      // Hermes 不问 Python —— 它**本身就是 Python**，跑得起来就说明有。
      // 它那道人工闸口在别处：安全扫描拦下时，放不放行是用户的决定。
      expect(installPrompt("hermes", locale, "windows")).toMatch(/停下来告诉我|stop and tell me/i);
    }
  });

  it("separates \"files are there\" from \"the link works\"", () => {
    // 这两件事混成一个「已安装」，正是用户卡住的地方：装完没 enable / 没授信 / 没重启时，
    // 目录照样在，而形象一直不动，界面却说一切正常。
    expect(linkState({ installed: false, lastSignalSeconds: null })).toBe("missing");
    expect(linkState({ installed: true, lastSignalSeconds: null })).toBe("unconfigured");
    expect(linkState({ installed: true, lastSignalSeconds: 3 })).toBe("connected");
    // 判据是「有没有写过」而不是「最近有没有写过」——
    // 一周没用那家 agent 的用户不该被告知需要重新配置
    expect(linkState({ installed: true, lastSignalSeconds: 9_000_000 })).toBe("connected");
    // 字段缺失（老版本 Rust / 调用失败）时不能谎报连通
    expect(linkState({ installed: true })).toBe("unconfigured");

    // 上报必须发生在**这次安装之后**。状态文件住在临时目录里，卸载不会删它，
    // 所以重装完还没开新会话时，上一次安装留下的文件会让界面说「已连通」——
    // 2026-09-03 实机 workbuddy 就是这样，而它一次新会话都还没跑。
    const now = Date.parse("2026-09-03T12:00:00Z");
    const justInstalled = { installed: true, installRecord: { at: "2026-09-03T11:59:00Z" } };
    expect(linkState({ ...justInstalled, lastSignalSeconds: 3600 }, now)).toBe("unconfigured");
    expect(linkState({ ...justInstalled, lastSignalSeconds: 10 }, now)).toBe("connected");
    // 账本里的时间也算数（Hermes 走目录时间兜底，它没有装机记录）
    expect(linkState({ installed: true, installedAt: "2026-09-03T11:59:00Z",
                       lastSignalSeconds: 3600 }, now)).toBe("unconfigured");
    // 时间读不出来时不能反过来谎报没通 —— 老版本 Rust 不带这两个字段
    expect(linkState({ installed: true, installedAt: "who knows", lastSignalSeconds: 3600 }, now))
      .toBe("connected");
  });

  it("does not send Claude Code and dsh users off to configure something that does not exist", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      const middle = (harness: string) => statusLabel("unconfigured", harness, locale);
      // 这两家装完即用：中间档的真实原因是还没开新会话，不是「需人工配置」
      expect(middle("claude-code")).not.toBe(CONNECTOR_TEXT[locale]["link.unconfigured"]);
      expect(middle("dsh")).toBe(middle("claude-code"));
      for (const harness of ["codex", "hermes", "workbuddy"]) {
        expect(middle(harness)).toBe(CONNECTOR_TEXT[locale]["link.unconfigured"]);
      }
      expect(statusLabel("connected", "codex", locale)).toBe(CONNECTOR_TEXT[locale]["link.connected"]);
      expect(statusLabel("missing", "codex", locale)).toBe(CONNECTOR_TEXT[locale]["link.missing"]);
    }
  });

  it("describes freshness in units a person reads", () => {
    expect(freshness(5, "zh-CN")).toBe("刚刚");
    expect(freshness(600, "zh-CN")).toBe("10 分钟前");
    expect(freshness(7200, "en")).toBe("2 hr ago");
    expect(freshness(86400 * 3, "en")).toBe("3 days ago");
  });

  it("never relies on the browser dialogs the webview does not implement", () => {
    // Tauri 的 webview 不实现 JS 的 alert/confirm/prompt（官方要用 dialog 插件），
    // 它们**静默返回**——表现是「点了没有任何反应」，用户既没有弹窗也没有错误（实机撞到）。
    const offenders: string[] = [];
    for (const file of readdirSync("src").filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      readFileSync(`src/${file}`, "utf8").split("\n").forEach((line, index) => {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
        if (/(^|[^.\w])(confirm|alert|prompt)\s*\(/.test(code)) offenders.push(`${file}:${index + 1} ${code}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("is reachable from the Agent tab and registered as Tauri commands", () => {
    expect(readFileSync("settings.html", "utf8")).toContain('data-list="connectors"');
    const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
    expect(lib).toContain("connectors::list_connectors");
    // app **既不装也不卸** connector：两件都是用户的 agent 干的活。
    // - 装：没有下载、没有解压、没有跑脚本（那三步正是杀软误报的来源，实机被卡巴删过文件）
    // - 卸：原来那个 uninstall_connector 对「从远程 marketplace 装」的那套完全没用 ——
    //   删的两个目录都不存在，于是删掉零个文件、报告成功，而账本原封不动（实测）
    expect(lib).not.toContain("connectors::install_connector");
    expect(lib).not.toContain("connectors::uninstall_connector");
  });
});
