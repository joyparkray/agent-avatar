import { afterEach, describe, expect, it, vi } from "vitest";
import { emotionForSemantic, mapHookState, SemanticDriver, type StateSnapshot, liveDoing } from "./semantic";

describe("six-state semantics", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it.each(["idle", "writing", "researching", "executing", "syncing", "error"] as const)("passes %s through", state => expect(mapHookState(state)).toBe(state));
  it.each([undefined, "unknown", "blocked", "interrupted"])("maps %s to idle", state => expect(mapHookState(state)).toBe("idle"));
  it("projects every base state to an emotion", () => expect(["idle", "writing", "researching", "executing", "syncing", "error"].map(state => emotionForSemantic(state as never))).toEqual(["relaxed", "focused", "curious", "active", "connected", "concerned"]));
  it("emits base before reaction and deduplicates on the reaction timestamp", async () => {
    vi.useFakeTimers(); vi.stubGlobal("window", globalThis);
    const snapshots = [
      { state: "executing", reaction: { kind: "blocked", sequence: 1, at: 100 } },
      { state: "executing", reaction: { kind: "blocked", sequence: 1, at: 100 } },
      { state: "executing", reaction: { kind: "blocked", sequence: 2, at: 101 } },
    ]; let index = 0; const events: string[] = [];
    const driver = new SemanticDriver(async () => snapshots[Math.min(index++, 2)], state => events.push(`base:${state}`), 10, 10, reaction => events.push(`reaction:${reaction}`));
    driver.start(); await vi.advanceTimersByTimeAsync(35); driver.stop();
    expect(events).toEqual(["base:executing", "reaction:blocked", "reaction:blocked"]);
  });
  it("replays a reaction after the hook's sequence counter resets", async () => {
    // 回归：.sessions 被重建后 sequence 从 1 重来。拿 sequence 当门时这里会整整吞掉一次反应。
    vi.useFakeTimers(); vi.stubGlobal("window", globalThis);
    const snapshots = [
      { state: "idle", reaction: { kind: "interrupted", sequence: 1, at: 100 } },
      { state: "idle", reaction: { kind: "interrupted", sequence: 1, at: 200 } },
    ]; let index = 0; const fired: string[] = [];
    const driver = new SemanticDriver(async () => snapshots[Math.min(index++, 1)], vi.fn(), 10, 10, reaction => fired.push(reaction));
    driver.start(); await vi.advanceTimersByTimeAsync(25); driver.stop();
    expect(fired).toEqual(["interrupted", "interrupted"]);
  });
  it.each([{ kind: "other", at: 1 }, { kind: "blocked", at: -1 }, { kind: "blocked", at: Number.NaN }, { kind: "blocked" }])("ignores invalid reaction $kind/$at", async reaction => {
    vi.useFakeTimers(); vi.stubGlobal("window", globalThis); const emitReaction = vi.fn();
    const driver = new SemanticDriver(async () => ({ state: "idle", reaction }), vi.fn(), 10, 10, emitReaction);
    driver.start(); await vi.advanceTimersByTimeAsync(20); driver.stop(); expect(emitReaction).not.toHaveBeenCalled();
  });
  it("holds the last state through a single failed read", async () => {
    // 一次读空/抖动就把形象打回 idle 会让表情无故掉一下；连续 3 次才回落。
    vi.useFakeTimers(); vi.stubGlobal("window", globalThis);
    const reads = [{ state: "executing" }, null, { state: "executing" }]; let index = 0; const states: string[] = [];
    const driver = new SemanticDriver(async () => reads[Math.min(index++, 2)], state => states.push(state), 10, 10);
    driver.start(); await vi.advanceTimersByTimeAsync(35); driver.stop();
    expect(states).toEqual(["executing"]);
  });
  it("falls back to idle once reads keep failing", async () => {
    vi.useFakeTimers(); vi.stubGlobal("window", globalThis);
    const states: string[] = []; let index = 0;
    const driver = new SemanticDriver(async () => (index++ === 0 ? { state: "executing" } : null), state => states.push(state), 10, 10);
    driver.start(); await vi.advanceTimersByTimeAsync(60); driver.stop();
    expect(states).toEqual(["executing", "idle"]);
  });
});

/**
 * 状态栏第二行「它具体在干嘛」。
 *
 * 去重键是**值本身**，不是 sequence：同一个工具的 pre/post 会连着报两次同样的详情，
 * 跟着 sequence 走就会让状态栏每两百毫秒重画一次。
 */
describe("详情那一行", () => {
  const drive = (snapshots: (StateSnapshot | null)[]) => {
    const said: string[] = [];
    let i = 0;
    const driver = new SemanticDriver(
      async () => snapshots[Math.min(i++, snapshots.length - 1)],
      () => {}, 1, 1, () => {}, doing => said.push(doing),
    );
    return { driver, said };
  };

  it("值变了才派发一次", async () => {
    const { driver, said } = drive([
      { state: "executing", doing: "Run tests" },
      { state: "executing", doing: "Run tests" },
      { state: "researching", doing: "main.ts" },
    ]);
    for (let round = 0; round < 3; round += 1) await (driver as never as { tick(): Promise<void> }).tick();
    expect(said).toEqual(["Run tests", "main.ts"]);
  });

  // 🔴 回落 idle 时详情必须跟着清 —— 空闲的人物身上挂着一句「Run tests」看起来像卡住了
  it("读不到状态而回落 idle 时，详情清空", async () => {
    const { driver, said } = drive([{ state: "executing", doing: "Run tests" }, null, null, null, null]);
    for (let round = 0; round < 5; round += 1) await (driver as never as { tick(): Promise<void> }).tick();
    expect(said.at(-1)).toBe("");
  });

  it("没有 doing 字段的老快照当作没有详情", async () => {
    const { driver, said } = drive([{ state: "executing", doing: "x" }, { state: "executing" }]);
    for (let round = 0; round < 2; round += 1) await (driver as never as { tick(): Promise<void> }).tick();
    expect(said).toEqual(["x", ""]);
  });
});

describe("详情的有效期", () => {
  // 🔴 详情比状态活得久，这是它能被看见的前提：工具跑完状态立刻回 idle，而这边 200ms
  // 采一次。2026-09-04 实机高频采样量到的窗口是 62 / 91 / 184 ms —— 用户只看到一闪。
  // 写入侧因此让详情多挂 1 秒并带上明写的过期时刻，这边照它判断。
  it("有效期内显示，过期了当空", () => {
    const now = 1_000_000_000_000;             // ms
    const until = now / 1000 + 0.5;            // 还剩 0.5 秒
    expect(liveDoing({ doing: "README.md", doing_until: until }, now)).toBe("README.md");
    expect(liveDoing({ doing: "README.md", doing_until: until }, now + 1000)).toBe("");
  });

  it("老连接器没有 doing_until —— 照旧显示，不能因为升级皮肤就把它吞掉", () => {
    expect(liveDoing({ doing: "README.md" }, Date.now())).toBe("README.md");
    expect(liveDoing({ doing: "README.md", doing_until: null }, Date.now())).toBe("README.md");
  });

  it("没有详情就是空", () => {
    expect(liveDoing({}, Date.now())).toBe("");
    expect(liveDoing({ doing: null }, Date.now())).toBe("");
  });
});
