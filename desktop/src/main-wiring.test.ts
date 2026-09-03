import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 回归：watchDocking 曾只有定义、没有调用点（一次静默失配的编辑造成），
// 吸附功能整体失效，而 tsc 与全部单测都是绿的 —— 未被调用的函数不会报错。
describe("main.ts wiring", () => {
  const source = readFileSync("src/main.ts", "utf8");
  const defined = [...source.matchAll(/^(?:async )?function ([A-Za-z][A-Za-z0-9]*)\(/gm)].map(match => match[1]);

  it("finds the boot-time helpers", () => {
    expect(defined).toEqual(expect.arrayContaining(["installMenu", "installBottomSnap", "startHitReporting", "boot"]));
  });

  it.each(defined)("calls %s somewhere, not just defines it", name => {
    const occurrences = source.split(`${name}(`).length - 1;
    expect(occurrences, `${name} 只有定义、没有调用点`).toBeGreaterThan(1);
  });
});

describe("Pixi render budget", () => {
  const source = readFileSync("src/live2d.ts", "utf8");

  it("caps the application ticker at 30 FPS after initialization", () => {
    expect(source).toMatch(/MAX_RENDER_FPS\s*=\s*30/);
    expect(source).toMatch(/await this\.app\.init[\s\S]*this\.app\.ticker\.maxFPS\s*=\s*MAX_RENDER_FPS/);
  });
});

describe("tool window lifecycle", () => {
  const source = readFileSync("src-tauri/src/lib.rs", "utf8");

  it("shows and focuses a tool window on its first creation", () => {
    const command = source.slice(source.indexOf("fn open_tool_window"), source.indexOf("fn set_hit_region"));
    expect(command).toMatch(/visible\(false\)[\s\S]*window\.show\(\)[\s\S]*window\.set_focus\(\)/);
  });
});

describe("window dragging", () => {
  const source = readFileSync("src/main.ts", "utf8");
  // 两条拖动路径各管一段，缺一不可：顶部那条 42px 隐形拖动条走 Tauri 原生拖动（按下即拖）；
  // 人物身上走 drag.ts 的阈值路径 —— 事件真正命中的是 canvas，它自己没有这个标记，
  // 于是 Tauri 的 drag.js 不接手（bare 标记只认直接命中该元素），单击换表情、双击播动作才不会被吞掉。
  it("keeps the drag bar native and leaves the model to the threshold path", () => {
    expect(source).toContain('<div class="drag" data-tauri-drag-region>');
    expect(source).toContain('<div class="model" data-tauri-drag-region>');
    expect(source).toContain("installWindowDragging(shell");
  });
  it("persists the successfully loaded model for the settings window", () => {
    expect(source).toMatch(/rememberGoodModel[\s\S]*await rememberModel\(currentModelDir\(\), currentModelSource\(\)\)/);
  });
});

describe("native menu order", () => {
  const source = readFileSync("src/native-menu.ts", "utf8");
  it("shows Expressions before Motions", () => {
    const items = source.slice(source.indexOf("const items = await Promise.all", source.indexOf("buildNativeMenu")), source.indexOf("return Menu.new"));
    expect(items.indexOf("Promise.resolve(expressions)")).toBeLessThan(items.indexOf("Promise.resolve(motions)"));
  });
});

// 画不对就直说：ren 那次是「加载成功但脸上没有眉毛鼻子嘴」，静默失败最难查。
describe("unsupported Cubism 5.1 offscreen models", () => {
  it("warns on load and lists it in the gallery, in the chosen language", () => {
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).toMatch(/model\.offscreenCount > 0[\s\S]*showUnsupportedNotice\(\)/);
    expect(main).toContain("UNSUPPORTED_CUBISM_TEXT[uiLanguage]");
    expect(readFileSync("src/live2d.ts", "utf8")).toContain("get offscreenCount()");
    expect(readFileSync("src/gallery.ts", "utf8")).toContain("UNSUPPORTED_CUBISM_TEXT[language()]");
    const prefs = readFileSync("src/prefs.ts", "utf8");
    expect(prefs).toContain('"zh-CN": "该模型使用 Cubism 5.1，当前渲染器不支持"');
    expect(prefs).toContain("This model uses Cubism 5.1, which the current renderer does not support");
  });
});

// 状态栏是常驻可见的唯一文字，中文界面下就该是中文；日志里记的仍是内部语义。
describe("status bar language", () => {
  const main = readFileSync("src/main.ts", "utf8");
  it("localizes state, reaction, click-through hint and manual activity", () => {
    // 文案本身搬到了 state-labels（设置页也要用同一份），main 只负责把它接到状态栏上
    const labels = readFileSync("src/state-labels.ts", "utf8");
    expect(labels).toMatch(/STATE_LABELS[\s\S]*"zh-CN": \{[\s\S]*idle: "空闲"[\s\S]*executing: "执行中"/);
    expect(labels).toMatch(/STATE_LABELS[\s\S]*en: \{[\s\S]*idle: "Idle"/);
    expect(main).toContain("stateLabel(lastSnapshot.semantic, uiLanguage, stateLabels)");
    expect(main).toContain('"zh-CN": { blocked: "受阻", interrupted: "被打断" }');
    expect(main).toContain('"zh-CN": "穿透中，悬停 3 秒可操作"');
    expect(main).toContain('"zh-CN": { expression: "表情", motion: "动作" }');
  });
  it("re-renders when the settings window switches language", () => {
    expect(main).toMatch(/payload\.language\) \{ uiLanguage = payload\.language; renderStatus\(\); \}/);
    // 渲染时才拼字符串，否则切语言只会影响下一次状态变化
    expect(main).toMatch(/function renderStatus[\s\S]*currentState = stateText\(\)/);
  });
});

// 回归：无边框窗口没有系统标题栏。两张引导卡都会盖住整窗，少了自带顶栏就变成
// 「拖不动、关不掉、卡在屏幕中央」（实机撞到，用户以为死机）。
describe("onboarding cards keep the window usable", () => {
  const source = readFileSync("src/main.ts", "utf8");

  it("gives both the model onboarding and the connector wizard a title bar", () => {
    expect(source.split("cardBar(").length - 1).toBeGreaterThanOrEqual(3);  // 1 定义 + 2 调用
  });

  it("makes the bar draggable and offers minimize and close", () => {
    const bar = source.slice(source.indexOf("function cardBar("), source.indexOf("首次运行的第二步"));
    expect(bar).toContain("data-tauri-drag-region");
    expect(bar).toContain("minimize()");
    expect(bar).toContain("dismiss.run");
  });

  it("declares the window permission the minimize button needs", () => {
    // 少了这条权限，按钮点下去被 Tauri 拒绝，又是一次「点了没反应」
    expect(readFileSync("src-tauri/capabilities/default.json", "utf8")).toContain("core:window:allow-minimize");
  });
});
