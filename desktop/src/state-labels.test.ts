import { describe, expect, it } from "vitest";
import { cleanStateLabels, stateLabel, STATE_LABELS } from "./state-labels";

describe("状态显示名", () => {
  it("没改过就用内置文案", () => {
    expect(stateLabel("error", "zh-CN")).toBe("出错");
    expect(stateLabel("error", "en")).toBe("Error");
  });

  // 用户的原话：error 想叫「生气中」，researching 想叫「正在思考哦」。
  it("改过的优先，而且不跟着界面语言变回去", () => {
    const mine = { error: "生气中" } as const;
    expect(stateLabel("error", "zh-CN", mine)).toBe("生气中");
    // 🔴 这是他给形象起的名字，不是一条待翻译的界面文案 —— 切英文界面不能吞掉
    expect(stateLabel("error", "en", mine)).toBe("生气中");
  });

  it("清空就恢复默认（只有空格也算清空）", () => {
    expect(stateLabel("error", "zh-CN", { error: "   " })).toBe("出错");
    expect(cleanStateLabels({ error: "  " })).toEqual({});
  });

  // writing 和 researching 内置都叫「思考中」—— 这正是要让用户能分开命名的原因
  it("默认合并的两档可以各改各的", () => {
    expect(STATE_LABELS["zh-CN"].writing).toBe(STATE_LABELS["zh-CN"].researching);
    const mine = { researching: "正在思考哦" } as const;
    expect(stateLabel("researching", "zh-CN", mine)).toBe("正在思考哦");
    expect(stateLabel("writing", "zh-CN", mine)).toBe("思考中");
  });

  it("不认识的状态名和超长的名字都挡在存的这一步", () => {
    expect(cleanStateLabels({ thinking: "旧配置里的状态" })).toEqual({});
    // 状态栏是一行，长了会把手动触发提示挤出去
    expect(cleanStateLabels({ error: "长".repeat(40) }).error).toHaveLength(24);
  });

  it("八个状态中英文都有，不留半句英文在中文界面上", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      for (const state of ["idle", "writing", "researching", "executing", "awaiting", "reviewing", "syncing", "error"]) {
        expect(STATE_LABELS[locale][state], `${locale}/${state}`).toBeTruthy();
      }
    }
  });
});
