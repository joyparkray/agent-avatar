import { beforeEach, describe, expect, it, vi } from "vitest";

// prefs 通过 Tauri 命令落盘。这里只关心「什么时候写」，不关心写去哪。
const calls: unknown[][] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(null); },
}));

const { rememberModel, rememberStatusPosition } = await import("./prefs");

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
