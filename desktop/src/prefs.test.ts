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

// 🔴 `readActivityDetail()` 在 store 还没载入时必须**看得出来是"还不知道"**，
// 而不是悄悄给出 false。
//
// 实机故障（2026-09-03，1.0.9）：main.ts 在模块顶层就
// `let detailEnabled = readActivityDetail()`，而 `loadPrefs()` 是异步的、要到 boot()
// 里才 await。于是启动时读到空 store → false，随后那句"每次启动都重申一遍"拿着这个
// 假的 false 去写 hook 的开关文件，把用户明明开着的详情写成关：
//
//   config.json               → activityDetail = true    （界面打着勾）
//   agent-avatar-options.json → {"activity": false}      （hook 不报详情）
//
// 修在 main.ts：`loadPrefs()` 之后重读一次。这条测试钉住"载入前后读数会变"这个前提 ——
// 前提一旦不成立（比如以后 store 改成同步预填），main.ts 那次重读就是多余的，
// 但也无害；而如果有人把重读删掉，故障会原样回来。
describe("配置载入之前不能替用户做决定", () => {
  it("空 store 读出 false，载入后读出 true —— 所以必须在 loadPrefs 之后再读一次", async () => {
    const { readActivityDetail, writeActivityDetail } = await import("./prefs");
    // 尚未写入任何值 = 模块顶层那一刻的样子
    const before = readActivityDetail();
    writeActivityDetail(true);
    const after = readActivityDetail();
    expect(before, "空 store 应当读出 false").toBe(false);
    expect(after, "有值之后应当读出 true").toBe(true);
    expect(before).not.toBe(after);
  });
});
