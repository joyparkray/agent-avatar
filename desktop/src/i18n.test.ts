import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONNECTOR_TEXT, postInstallSteps, CONNECTOR_HARNESSES } from "./connectors";
import { errorMessage, ERROR_CODES } from "./errors";
import { UNSUPPORTED_CUBISM_TEXT } from "./prefs";

const CJK = /[一-鿿　-〿＀-￯]/;

/**
 * 发布前逐条过文案时发现的毛病：英文界面里冒出中文（窗口标题栏的「设置」、Rust 返回的报错、
 * 画廊整页）。类型能保证两种语言的**键**一致，但保证不了 en 那边真的翻过 —— 这里补上。
 */
describe("English UI carries no Chinese", () => {
  it("keeps every English connector string free of CJK", () => {
    for (const [key, value] of Object.entries(CONNECTOR_TEXT.en)) {
      expect(CJK.test(value), `connectors.en.${key}: ${value}`).toBe(false);
    }
  });

  it("keeps every English post-install step free of CJK", () => {
    for (const harness of CONNECTOR_HARNESSES) {
      for (const step of postInstallSteps(harness, "en")) {
        expect(CJK.test(step), `${harness}: ${step}`).toBe(false);
      }
    }
  });

  it("keeps every English error message free of CJK", () => {
    for (const code of ERROR_CODES) {
      const message = errorMessage(`${code}|detail`, "en");
      expect(CJK.test(message), `${code}: ${message}`).toBe(false);
    }
  });

  it("keeps the English settings strings free of CJK", () => {
    // TEXT 不导出（设置页是入口模块），按源码取那一段
    const source = readFileSync("src/settings.ts", "utf8");
    const english = source.slice(source.indexOf("\n  en: {"), source.indexOf("};", source.indexOf("\n  en: {")));
    const values = [...english.matchAll(/"[^"]+":\s*"([^"]*)"/g)].map(match => match[1]);
    expect(values.length).toBeGreaterThan(30);
    for (const value of values) expect(CJK.test(value), value).toBe(false);
  });

  it("calls a model a model everywhere, not the pre-rename word", () => {
    // 「皮肤」是改名前的叫法（Echo Skin 时代）。同一个东西两个名字，用户会以为是两个功能。
    const files = ["src/settings.ts", "src/main.ts", "src/connectors.ts", "src/errors.ts", "src/native-menu.ts"];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const strings = [...source.matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)].map(match => match[1] ?? match[2] ?? "");
      for (const value of strings) expect(value.includes("皮肤"), `${file}: ${value}`).toBe(false);
    }
  });

  it("has an English wording for the unsupported-Cubism notice", () => {
    expect(CJK.test(UNSUPPORTED_CUBISM_TEXT.en)).toBe(false);
    expect(CJK.test(UNSUPPORTED_CUBISM_TEXT["zh-CN"])).toBe(true);
  });

  it("localizes both window titles instead of leaving Chinese in the native title bar", () => {
    // 原生标题栏不跟着 document.title 变，必须显式 setTitle（这正是那两个中文字的来源）
    for (const file of ["src/settings.ts", "src/gallery.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/setTitle\(title\)/);
      // getCurrentWindow() 在非 Tauri 环境同步抛错，不裹 try 会打断整个 boot
      expect(source).toMatch(/try \{ void getCurrentWindow\(\)\.setTitle/);
    }
    // Rust 侧的默认标题保持语言中立
    const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
    const windows = lib.slice(lib.indexOf('"settings" =>'), lib.indexOf('other =>'));
    expect(CJK.test(windows)).toBe(false);
  });
});

describe("switching language repaints what JS drew", () => {
  it("redraws the checklists, not just the [data-i18n] nodes", () => {
    // 名单是 JS 现生成的：切到英文后，空名单那句「这个模型没有可用项」原样留在页面上（实测）
    const source = readFileSync("src/settings.ts", "utf8");
    const handler = source.slice(source.indexOf("rememberLanguage(value)"), source.indexOf("announce({ language: value })"));
    for (const call of ["applyLanguage(value)", "showIssues()", "showModels()", "showConnectors()", "redraws.forEach"]) {
      expect(handler, call).toContain(call);
    }
  });
});

describe("error codes stay in sync with the Rust side", () => {
  it("translates every code the Rust side can return", () => {
    const rust = readFileSync("src-tauri/src/lib.rs", "utf8");
    const list = rust.slice(rust.indexOf("pub const ALL:"), rust.indexOf("];", rust.indexOf("pub const ALL:")));
    const names = [...list.matchAll(/\b([A-Z][A-Z0-9_]+)\b/g)].map(match => match[1]).filter(name => name !== "ALL");
    const codes = names.map(name => {
      const found = rust.match(new RegExp(`pub const ${name}: &str = "([^"]+)"`));
      return found![1];
    });
    expect(codes.length).toBeGreaterThan(5);   // 只是防止正则一无所获，不是在数具体有几条
    expect([...ERROR_CODES].sort()).toEqual([...codes].sort());
  });

  it("shows an unknown code as-is instead of swallowing it", () => {
    expect(errorMessage("some-new-code|boom", "en")).toBe("some-new-code|boom");
    expect(errorMessage(new Error("archive"), "zh-CN")).toContain("压缩包");
  });
});
