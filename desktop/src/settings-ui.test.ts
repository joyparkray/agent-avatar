import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("settings information architecture", () => {
  const html = readFileSync("settings.html", "utf8");

  it.each(["general", "video", "agent", "behavior", "models"])("has the %s tab and panel", name => {
    expect(html).toContain(`data-tab="${name}"`);
    expect(html).toContain(`data-panel="${name}"`);
  });

  it("puts render controls in Video and state mapping in Agent", () => {
    const video = html.slice(html.indexOf('data-panel="video"'), html.indexOf('data-panel="agent"'));
    expect(video).toContain('data-act="scale"');
    expect(video).toContain('data-act="quality"');
    expect(video).toContain('data-act="fps"');
    expect(html.slice(html.indexOf('data-panel="agent"'))).toContain('data-list="state-motions"');
  });

  it("orders Expressions before Motions and labels interaction columns explicitly", () => {
    const behavior = html.slice(html.indexOf('data-panel="behavior"'), html.indexOf('data-panel="models"'));
    expect(behavior.indexOf('data-list="expressions"')).toBeLessThan(behavior.indexOf('data-list="motions"'));
    // 标题短是有意的：52px 的格子塞不下「鼠标双击 / Mouse Double-click」，英文下两个按钮
    // 会一高一低。含义改由上面那句 hint 承担，这里只保证三列各有自己的标题。
    expect(behavior).toContain(">单击<");
    expect(behavior).toContain(">双击<");
    expect(behavior).toContain(">闲置<");
  });

  it("offers Chinese and English through the persisted language control", () => {
    expect(html).toContain('data-act="language"');
    expect(readFileSync("src/settings.ts", "utf8")).toContain('LANGUAGES');
  });

  it("uses Model as the user-facing product term", () => {
    const settings = readFileSync("src/settings.ts", "utf8");
    expect(settings).toContain('"tab.models": "模型"');
    expect(settings).toContain('"tab.models": "Models"');
    expect(settings).not.toContain('"tab.models": "皮肤"');
  });
});

describe("source menu ordering", () => {
  const menu = readFileSync("src/native-menu.ts", "utf8");
  it("places None first for audio and None then Auto for state", () => {
    expect(menu).toMatch(/audioLabels[\s\S]*\[\["off"[\s\S]*\["global"[\s\S]*\["file"[\s\S]*\["hermes"/);
    expect(menu).toMatch(/stateLabels[\s\S]*\[\s*\["off"[\s\S]*\["auto"[\s\S]*\["claude-code"[\s\S]*\["codex"[\s\S]*\["dsh"[\s\S]*\["hermes"[\s\S]*\["workbuddy"/);
  });

  it("shows installed models with hide and delete controls", () => {
    const settings = readFileSync("src/settings.ts", "utf8");
    expect(settings).toContain('invoke<InstalledModel[]>("list_installed_models")');
    expect(settings).toContain('invoke("delete_model"');
    expect(settings).toContain('checkbox.type = "checkbox"');
    expect(settings).toContain('"models.hide": "隐藏"');
    expect(settings).toContain("writeHiddenModels(hidden)");
  });
});

describe("model interaction behavior", () => {
  const main = readFileSync("src/main.ts", "utf8");
  it("filters hidden installed models from menus", () => {
    expect(main).toMatch(/menuModels[\s\S]*hidden\.includes\(model\.dir\)/);
  });
  it("looks ahead and suppresses gaze changes while speaking", () => {
    expect(main).toMatch(/applySpeaking[\s\S]*model\.lookAhead\(\)/);
    expect(main).toMatch(/cursor-position[\s\S]*if \(eyeTracking\) model\.lookAt/);
    expect(main).toContain('shell.dataset.speaking === "true" || eyeTracking');
  });

  it("looks at the user before click expressions and double-click motions", () => {
    expect(main).toMatch(/pickEnabledExpression[\s\S]*model\.lookAhead\(\)[\s\S]*playExpression/);
    expect(main).toMatch(/pickEnabledMotion[\s\S]*model\.lookAhead\(\)[\s\S]*playMotion/);
  });
  it("shows only user-triggered expressions and motions in the status bar", () => {
    expect(main).toMatch(/shell\.addEventListener\("click"[\s\S]*showManualActivity\("expression", name\)/);
    expect(main).toMatch(/shell\.addEventListener\("dblclick"[\s\S]*showManualActivity\("motion", motionLabel\(inventory, choice\)\)/);
    const idle = main.slice(main.indexOf("const idle = new IdleAutonomy"));
    expect(idle).not.toContain("showManualActivity");
  });
  // 光标只归 CSS 管，别再往原生方向加东西。2026-08-28 为「光标不出手型」查了一晚上，
  // 试过 setCursorIcon、NSCursor 直压、disableCursorRects，全都无效 ——
  // 最后查出是**远程桌面客户端不同步光标形状**，换个客户端接入，这份 CSS 原样就出手掌。
  it("leaves the model cursor to CSS", () => {
    expect(main).not.toContain("setCursorIcon");
    expect(readFileSync("src/style.css", "utf8")).toContain(".model:active,.drag:active{cursor:grabbing}");
  });
});

describe("empty model onboarding", () => {
  const main = readFileSync("src/main.ts", "utf8");
  it.each(["下载免费模型", "打开模型文件夹", "装好了，重新加载"])("offers %s", label => {
    expect(main).toContain(label);
  });
  it("opens the managed model directory", () => {
    expect(main).toMatch(/data-act="open-models"[\s\S]*open_models_dir/);
  });
  it("makes the no-model window interactive and emphasizes the extracted folder", () => {
    // 「模型文件夹」是同一个东西在设置页/右键菜单里的叫法，引导页原来叫「安装目录」，
    // 用户按提示去找一个别处根本不存在的名字（文案里不该再出现旧叫法，注释不算）
    expect(main).toContain("解压出来的模型文件夹");
    const copy = main.slice(main.indexOf("const ONBOARDING_TEXT"), main.indexOf("} as const;"));
    expect(copy).not.toContain("安装目录");
    expect(main).toMatch(/set_hit_region[\s\S]*width: innerWidth[\s\S]*height: innerHeight/);
    expect(main).toContain('data-act="reload"');
  });
  it("offers a persisted Chinese and English language switch", () => {
    expect(main).toContain('data-act="onboarding-language"');
    expect(main).toContain("Use a model you already have");
    expect(main).toContain("rememberLanguage(next)");
  });
});
