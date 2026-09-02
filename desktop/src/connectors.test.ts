import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diagnosePrompt, diagnosisReasons, stateFileName } from "./connector-diagnosis";
import { CONNECTOR_HARNESSES, CONNECTOR_TEXT, freshness, HARNESS_LABELS, linkState, postInstallSteps, progressText, statusLabel } from "./connectors";

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

  it("names every install stage and passes unknown ones through", () => {
    for (const stage of ["download", "extract", "install"]) {
      expect(progressText(stage, "zh-CN")).not.toBe(stage);
      expect(progressText(stage, "en")).not.toBe(stage);
    }
    expect(progressText("mystery", "en")).toBe("mystery");
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
    for (const command of ["list_connectors", "install_connector", "uninstall_connector"]) {
      expect(lib).toContain(`connectors::${command}`);
    }
  });
});
