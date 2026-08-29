import { describe, expect, it } from "vitest";
import { defaultEnabledExpressions, defaultEnabledMotions, motionGroupLabel, motionLabel, parseInventory, parseModelIndex, pickEnabledExpression, pickEnabledMotion } from "./inventory";

describe("parseInventory", () => {
  it("lists motion groups with counts and named expressions", () => {
    expect(parseInventory({ FileReferences: {
      Motions: { Idle: [{}, {}], TapBody: [{}, {}, {}, {}] },
      Expressions: [{ Name: "F01" }, { Name: "F02" }],
    } })).toEqual({ motions: [{ group: "Idle", count: 2, files: ["", ""] }, { group: "TapBody", count: 4, files: ["", "", "", ""] }], expressions: ["F01", "F02"] });
  });
  it("returns an empty expression list for models that ship none (Hiyori)", () => {
    expect(parseInventory({ FileReferences: { Motions: { Idle: [{}] } } })).toEqual({ motions: [{ group: "Idle", count: 1, files: [""] }], expressions: [] });
  });
  it("skips empty groups and tolerates malformed input", () => {
    expect(parseInventory({ FileReferences: { Motions: { Idle: [], Tap: [{}] } } }).motions).toEqual([{ group: "Tap", count: 1, files: [""] }]);
    expect(parseInventory(null)).toEqual({ motions: [], expressions: [] });
  });
});

// haru_greeter 把 27 个动作全放在组名为 "" 的组里，界面上只剩序号可区分 —— 文件名才是作者起的名字。
describe("motionLabel", () => {
  const inventory = parseInventory({ FileReferences: { Motions: {
    "": [{ File: "motion/haru_g_idle.motion3.json" }, { File: "motion/haru_g_m01.motion3.json" }],
    Tap: [{ File: "motion/tap.motion3.json" }],
  } } });
  it("names an unnamed group's motions by their motion file", () => {
    expect(motionLabel(inventory, ["", 0])).toBe("haru_g_idle");
    expect(motionLabel(inventory, ["", 1])).toBe("haru_g_m01");
  });
  it("keeps group + index where the group has a name", () => {
    expect(motionLabel(inventory, ["Tap", 0])).toBe("Tap 0");
  });
  it("falls back to the index when even the file is missing", () => {
    expect(motionLabel({ motions: [{ group: "", count: 1 }], expressions: [] }, ["", 0])).toBe("#0");
  });
  it("gives the unnamed group a readable menu title", () => {
    expect(motionGroupLabel("")).toBe("（未命名）");
    expect(motionGroupLabel("", true)).toBe("(unnamed)");
    expect(motionGroupLabel("Tap")).toBe("Tap");
  });
});

describe("parseModelIndex", () => {
  it("keeps well-formed entries and drops the rest", () => {
    expect(parseModelIndex({ models: [{ dir: "haru", label: "Haru" }, { dir: 1 }, null] })).toEqual([{ dir: "haru", label: "Haru" }]);
    expect(parseModelIndex(null)).toEqual([]);
  });
});

describe("motion random pool", () => {
  const inventory = { motions: [{ group: "Idle", count: 2 }, { group: "TapBody", count: 4 }], expressions: [] };

  // Idle 是常驻环境动作，当作双击「回应」不合适，故默认不进名单。
  it("defaults to every motion except Idle", () => {
    expect(defaultEnabledMotions(inventory)).toEqual(["TapBody:0", "TapBody:1", "TapBody:2", "TapBody:3"]);
  });
  it("falls back to Idle when the model has nothing else", () => {
    expect(defaultEnabledMotions({ motions: [{ group: "Idle", count: 2 }], expressions: [] })).toEqual(["Idle:0", "Idle:1"]);
  });
  it("picks only from the enabled list", () => {
    for (const r of [0, 0.5, 0.999]) {
      expect(pickEnabledMotion(inventory, ["TapBody:2"], () => r)).toEqual(["TapBody", 2]);
    }
  });
  it("does nothing when the pool is emptied", () => {
    expect(pickEnabledMotion(inventory, [])).toBeUndefined();
  });
  it("ignores keys that do not exist on this model", () => {
    expect(pickEnabledMotion(inventory, ["Flick:0"])).toBeUndefined();
  });
});

describe("expression random pool", () => {
  const inventory = { motions: [], expressions: ["F01", "F02", "F03"] };

  it("defaults to every expression", () => {
    expect(defaultEnabledExpressions(inventory)).toEqual(["F01", "F02", "F03"]);
  });
  it("picks only from the enabled list", () => {
    for (const r of [0, 0.5, 0.999]) expect(pickEnabledExpression(inventory, ["F02"], null, () => r)).toBe("F02");
  });
  it("avoids repeating the previous expression", () => {
    for (const r of [0, 0.5, 0.999]) expect(pickEnabledExpression(inventory, ["F01", "F02"], "F01", () => r)).toBe("F02");
  });
  it("reuses the only enabled expression rather than going silent", () => {
    expect(pickEnabledExpression(inventory, ["F01"], "F01", () => 0)).toBe("F01");
  });
  it("does nothing when the pool is emptied", () => {
    expect(pickEnabledExpression(inventory, [], null)).toBeUndefined();
  });
  // Hiyori 不带表情，单击应当安静地什么都不做。
  it("returns undefined for models without expressions", () => {
    expect(pickEnabledExpression({ motions: [], expressions: [] }, ["F01"], null)).toBeUndefined();
  });
});
