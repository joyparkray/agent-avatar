import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diagnosisReasons } from "./connector-diagnosis";
import { CONNECTOR_HARNESSES, CONNECTOR_TEXT, freshness, HARNESS_LABELS, linkState, postInstallSteps, statusLabel, installedMessage } from "./connectors";

describe("connector install wizard", () => {
  // 🔴 这里曾经有十五条测试，盯的是「app 出提示词、用户的 agent 去执行安装」那条路。
  // 那条路被两轮实机测试推翻了（14 个缺陷，全部来自 agent 的自由发挥），装 / 卸搬进了
  // Rust。它们的意图没有丢，只是搬了家：动词来自 CLI 的 --help、解释器路径在命令行里
  // 表达得出来、dsh 的托管块幂等、以及真机装卸，都在 connector_install.rs 的测试里。
  // 留在这里的是**界面自己的判断**：状态分档、文案、以及那些说给卡住的人听的话。
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
    // 上报过、但那次早于这次安装 = **以前是通的，装完还没通**。这一档单独成立，
    // 因为它和「从没上报过」处境不同：Codex 升级后要重新授信，说「还没上报过」会把人带偏。
    expect(linkState({ ...justInstalled, lastSignalSeconds: 3600 }, now)).toBe("regressed");
    expect(linkState({ ...justInstalled, lastSignalSeconds: 10 }, now)).toBe("connected");
    // 从没上报过的仍然是 unconfigured
    expect(linkState({ ...justInstalled, lastSignalSeconds: null }, now)).toBe("unconfigured");
    // 账本里的时间也算数（Hermes 走目录时间兜底，它没有装机记录）
    expect(linkState({ installed: true, installedAt: "2026-09-03T11:59:00Z",
                       lastSignalSeconds: 3600 }, now)).toBe("regressed");
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

  it("stops saying \"waiting for the first session\" once that stops being true", () => {
    // 装了两天还没上报时，这句就成了安慰话 —— 而它正上方会写着「一直没通？可能是这些原因」。
    // 两句自相矛盾，实机渲染出来一眼就看见（dsh 那一行），光读代码发现不了。
    for (const locale of ["zh-CN", "en"] as const) {
      const fresh = statusLabel("unconfigured", "dsh", locale, true);
      const stale = statusLabel("unconfigured", "dsh", locale, false);
      expect(fresh).toMatch(/等待首次会话|waiting for the first session/);
      expect(stale).not.toBe(fresh);
      expect(stale).toMatch(/一直没有上报|never reported/);
      // 有人工步骤的那几家不走这条分支：对它们「需人工配置」才是实话
      expect(statusLabel("unconfigured", "codex", locale, false))
        .toBe(CONNECTOR_TEXT[locale]["link.unconfigured"]);
    }
  });

  it("says something different when it used to work", () => {
    // 「从没上报过」和「以前是通的、升级后断了」是两种处境，话不能一样 ——
    // 后者最常见的原因是 Codex 按 hook 内容哈希记信任，升级后要重新 /hooks 授信。
    for (const locale of ["zh-CN", "en"] as const) {
      const regressed = statusLabel("regressed", "codex", locale);
      expect(regressed).toBeTruthy();
      expect(regressed).not.toBe(statusLabel("unconfigured", "codex", locale));
      expect(CONNECTOR_TEXT[locale]["diagnosis.regressed"]).toBeTruthy();
      expect(CONNECTOR_TEXT[locale]["diagnosis.regressed.codex"]).toMatch(/hooks/);
    }
  });

  it("has every piece of text it asks for", () => {
    // `text("…")` 拼错一个 key 的表现是界面上直接显示那个 key —— tsc 抓不到，
    // 而它出现的地方恰恰是用户卡住的时候。
    const ui = readFileSync("src/connectors.ts", "utf8");
    const keys = new Set<string>();
    for (const match of ui.matchAll(/\btext\("([^"]+)"\)/g)) keys.add(match[1]);
    expect(keys.size).toBeGreaterThan(8);
    for (const key of keys) {
      for (const locale of ["zh-CN", "en"] as const) {
        expect(CONNECTOR_TEXT[locale][key], `${locale} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it("is reachable from the Agent tab and registered as Tauri commands", () => {
    expect(readFileSync("settings.html", "utf8")).toContain('data-list="connectors"');
    const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
    for (const command of ["connectors::list_connectors",
                           "connector_install::install_connector",
                           "connector_install::uninstall_connector"]) {
      expect(lib).toContain(command);
      // 注册了还不够：不在能力清单里的话，前端一调就被拒（Rust 侧有测试盯着这条，
      // 这里守住的是「界面确实在调这三个」）
      expect(readFileSync("src-tauri/permissions/skin.toml", "utf8"))
        .toContain(command.split("::")[1]);
    }
    const ui = readFileSync("src/connectors.ts", "utf8");
    expect(ui).toContain('invoke(command, { harness })');
    // 提示词那条路已经拆掉：界面上不该再有任何「复制一段话给你的 agent」
    expect(ui).not.toMatch(/installPrompt|uninstallPrompt|updatePrompt|diagnosePrompt|clipboard/);
  });
});

describe("装完之后该让用户做什么", () => {
  // 🔴 「开一个新会话就会生效」对 in-process 的两家是**错的**，而且是会稳定误导的那种错：
  // 用户照做、不生效、以为坏了。Hermes 是 in-process 的 Python 包、dsh 是 in-process 的
  // cordis 插件 —— 模块加载进内存之后换磁盘文件不会重新加载，必须重启进程。
  // 其余三家每个事件起一个独立 hook 进程，每次重新读文件，所以换了立刻生效。
  // 2026-09-04 实机连撞两次（连接器 10:41 装，hermes 进程 10:23 起的，一直跑旧模块）。
  it("in-process 的两家要说重启进程，并带上它自己的名字", () => {
    for (const harness of ["hermes", "dsh"] as const) {
      const zh = installedMessage("zh-CN", harness);
      expect(zh).toContain("重启");
      expect(zh).toContain(HARNESS_LABELS[harness]);
      expect(zh, "不能再说「开一个新会话就会生效」").not.toContain("开一个新会话就会生效");
      expect(installedMessage("en", harness)).toContain("Restart");
    }
  });

  it("其余三家仍然说新会话 —— 它们确实是那样生效的", () => {
    for (const harness of ["claude-code", "codex", "workbuddy"] as const) {
      expect(installedMessage("zh-CN", harness)).toContain("新会话");
      expect(installedMessage("en", harness)).toContain("next session");
    }
  });

  it("占位符必须被换掉，别把 {name} 直接显示给用户", () => {
    for (const harness of CONNECTOR_HARNESSES) {
      for (const locale of ["zh-CN", "en"] as const) {
        expect(installedMessage(locale, harness)).not.toContain("{name}");
      }
    }
  });
});
