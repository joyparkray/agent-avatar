import { describe, expect, it } from "vitest";
import {
  acceleratorFromEvent, actionLabel, actionsFor, CLICK, DBLCLICK, isUsableShortcut,
  listActions, migrateTriggers, pickAction, shortcutsIn, type ActionItem, type Trigger,
} from "./actions";
import type { ModelInventory } from "./inventory";

const inventory: ModelInventory = {
  expressions: ["F1", "Q"],
  motions: [{ group: "TapBody", count: 2, files: ["wave", "bow"] }],
};

describe("可触发项", () => {
  it("表情和动作合成一张表，键互不相撞", () => {
    const items = listActions(inventory);
    expect(items.map(item => item.key)).toEqual([
      "expression:F1", "expression:Q", "motion:TapBody:0", "motion:TapBody:1",
    ]);
    expect(items.filter(item => item.kind === "motion").every(item => item.motion)).toBe(true);
  });

  it("组名为空时用文件名当原名，而不是一排分不出来的序号", () => {
    const nameless = listActions({ expressions: [], motions: [{ group: "", count: 2, files: ["haru_m01", "haru_m02"] }] });
    expect(nameless.map(item => item.origin)).toEqual(["haru_m01", "haru_m02"]);
  });

  /** 这是别名功能的核心：绝大多数模型作者其实起过名，用户一个字都不用填。 */
  it("显示名三层回落：别名 → 作者起的名 → 原名", () => {
    const items = listActions(inventory, { F1: "生气", wave: "挥手" });
    const [f1, q, wave] = items;
    expect(actionLabel(f1)).toBe("生气");                          // 作者起的
    expect(actionLabel(q)).toBe("Q");                              // 谁都没起，回落原名
    expect(actionLabel(wave)).toBe("挥手");
    expect(actionLabel(f1, { "expression:F1": "炸毛" })).toBe("炸毛");   // 用户的优先
    expect(actionLabel(f1, { "expression:F1": "   " })).toBe("生气");    // 空白别名不算数
  });

  it("别名改的是显示，键不变 —— 否则改个名就把触发绑定弄丢了", () => {
    const items = listActions(inventory, { F1: "生气" });
    const aliases = { "expression:F1": "炸毛" };
    expect(actionLabel(items[0], aliases)).toBe("炸毛");
    expect(items[0].key).toBe("expression:F1");
  });
});

describe("触发绑定", () => {
  const items = listActions(inventory);
  const triggers: Record<string, Trigger> = {
    "expression:F1": CLICK, "expression:Q": CLICK,
    "motion:TapBody:0": DBLCLICK, "motion:TapBody:1": "Control+X",
  };

  it("同一个触发绑多项 = 随机池", () => {
    expect(actionsFor(items, triggers, CLICK).map(item => item.origin)).toEqual(["F1", "Q"]);
    expect(actionsFor(items, triggers, DBLCLICK)).toHaveLength(1);
    expect(actionsFor(items, triggers, "Control+X")).toHaveLength(1);
  });

  it("单击可以绑动作、双击可以绑表情 —— 合成一张表之后不该再有这种限制", () => {
    const mixed: Record<string, Trigger> = { "motion:TapBody:0": CLICK, "expression:F1": DBLCLICK };
    expect(actionsFor(items, mixed, CLICK)[0].kind).toBe("motion");
    expect(actionsFor(items, mixed, DBLCLICK)[0].kind).toBe("expression");
  });

  it("要注册的快捷键去重，且不含单击/双击", () => {
    expect(shortcutsIn({ a: CLICK, b: DBLCLICK, c: "Control+X", d: "Control+X", e: "Alt+1" }))
      .toEqual(["Control+X", "Alt+1"]);
  });

  it("避开上一次挑中的那个，但只剩一个时照样播它", () => {
    const pool = actionsFor(items, triggers, CLICK);
    expect(pickAction(pool, "expression:F1", () => 0)?.origin).toBe("Q");
    expect(pickAction(pool.slice(0, 1), "expression:F1", () => 0)?.origin).toBe("F1");
    expect(pickAction([], "x")).toBeUndefined();
    // random() 返回 0.999… 时不能越界
    expect(pickAction(pool, undefined, () => 0.9999)?.origin).toBe("Q");
  });
});

describe("快捷键校验", () => {
  /**
   * 这条是这个功能唯一的伤人方式：全局快捷键不看焦点，给「挥手」配了 `X`，
   * 用户在任何程序里打字打到 x 都会挥手。
   */
  it("拒绝不带修饰键的单键", () => {
    expect(isUsableShortcut("X")).toBe(false);
    expect(isUsableShortcut("F5")).toBe(false);
    expect(isUsableShortcut("Control+X")).toBe(true);
    expect(isUsableShortcut("Control+Shift+1")).toBe(true);
  });

  it("拒绝只有修饰键、或有多个实际按键的组合", () => {
    expect(isUsableShortcut("Control+Shift")).toBe(false);
    expect(isUsableShortcut("Control+X+Y")).toBe(false);
    expect(isUsableShortcut("")).toBe(false);
  });
});

describe("录制按键", () => {
  const press = (over: Partial<KeyboardEvent>) => acceleratorFromEvent({
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, key: "", code: "", ...over,
  } as KeyboardEvent);

  it("按住修饰键但还没按实际键时不算录好", () => {
    expect(press({ ctrlKey: true, key: "Control", code: "ControlLeft" })).toBeUndefined();
    expect(press({ shiftKey: true, key: "Shift", code: "ShiftLeft" })).toBeUndefined();
  });

  it("字母用物理键位，避免布局差异", () => {
    expect(press({ ctrlKey: true, key: "x", code: "KeyX" })).toBe("Control+X");
    expect(press({ ctrlKey: true, shiftKey: true, key: "X", code: "KeyX" })).toBe("Control+Shift+X");
    expect(press({ altKey: true, key: "1", code: "Digit1" })).toBe("Alt+1");
  });

  it("功能键与方向键有名字", () => {
    expect(press({ ctrlKey: true, key: "F5", code: "F5" })).toBe("Control+F5");
    expect(press({ ctrlKey: true, key: "ArrowUp", code: "ArrowUp" })).toBe("Control+Up");
    expect(press({ ctrlKey: true, key: " ", code: "Space" })).toBe("Control+Space");
  });
});

describe("从旧名单迁移", () => {
  const items = listActions(inventory);

  it("旧的单击表情名单与双击动作名单变成触发绑定", () => {
    expect(migrateTriggers(items, ["F1"], ["TapBody:0"])).toEqual({
      "expression:F1": CLICK, "motion:TapBody:0": DBLCLICK,
    });
  });

  /** 换过模型、或模型内容变了之后，旧名单里会留着已经不存在的项。 */
  it("丢掉模型里已经没有的项", () => {
    expect(migrateTriggers(items, ["没了"], ["Gone:9"])).toEqual({});
  });

  it("空名单迁出空绑定，不会凭空给用户绑上什么", () => {
    expect(migrateTriggers(items, [], [])).toEqual({});
  });
});
