import { beforeEach, describe, expect, it, vi } from "vitest";

// prefs 通过 Tauri 命令落盘。这里只关心「什么时候写」，不关心写去哪。
const calls: unknown[][] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(null); },
}));

const { rememberModel, rememberStatusPosition, readStateExpressions, rememberStateExpressions } = await import("./prefs");

describe("切模型的写入不能走防抖", () => {
  beforeEach(() => { calls.length = 0; vi.useRealTimers(); });

  // 回归：菜单里选了模型 → 写配置 → 立刻重载页面。写走 200ms 防抖时，页面在窗口内
  // 被拆掉，`modelSource` 丢了而 `model` 从 URL 参数拿到新值 —— 于是拿新目录去旧来源里
  // 找，报「invalid avatar manifest」，看起来像模型坏了。实机撞到过。
  it("rememberModel 立即落盘，且 promise 兑现时写已经发出去了", async () => {
    const pending = rememberModel("haru_ja/runtime", "installed");
    expect(calls.length, "应当立刻发出 write_config，而不是等 200ms").toBe(1);
    await pending;
    const [command, payload] = calls[0] as [string, { config: Record<string, unknown> }];
    expect(command).toBe("write_config");
    // 两个键必须在同一次写里 —— 只落一个的话就是上面那个故障形状
    expect(payload.config.model).toBe("haru_ja/runtime");
    expect(payload.config.modelSource).toBe("installed");
  });

  it("普通设置仍然走防抖（连续拖滑块只写一次）", async () => {
    rememberStatusPosition("top-left");
    expect(calls.length, "普通设置不该立刻写").toBe(0);
    await new Promise(resolve => setTimeout(resolve, 260));
    expect(calls.length).toBe(1);
  });
});

/**
 * 语义状态 → 表情。动作那一半一直有，表情这一半是补上的：`playSemantic` 本来就
 * 「播动作 + 设表情」，只是表情以前只能由模型作者在 avatar.json 里写死。
 */
describe("每个状态记住一个表情", () => {
  it("存进去什么读出来什么", async () => {
    await rememberStateExpressions("haru/runtime", { reviewing: "f03", error: "f08" });
    expect(readStateExpressions("haru/runtime")).toEqual({ reviewing: "f03", error: "f08" });
  });

  // 清空选择时界面写的是空串。存下来会变成一个查不到的表情，表现是「设了没反应」——
  // 读的时候滤掉，等同于「模型默认」。不认识的状态名同理 —— 比如老配置里的 thinking，现在这个状态叫 reviewing。
  it("空名字和不认识的状态都当作没配", async () => {
    await rememberStateExpressions("haru/runtime",
      { reviewing: "", error: "f08", thinking: "f01" } as never);
    expect(readStateExpressions("haru/runtime")).toEqual({ error: "f08" });
  });

  it("每个模型各存各的", async () => {
    await rememberStateExpressions("a/runtime", { reviewing: "f01" });
    await rememberStateExpressions("b/runtime", { reviewing: "f02" });
    expect(readStateExpressions("a/runtime").reviewing).toBe("f01");
  });
});
