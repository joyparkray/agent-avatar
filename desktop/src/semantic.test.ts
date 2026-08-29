import { afterEach, describe, expect, it, vi } from "vitest";
import { emotionForSemantic, mapHookState, SemanticDriver } from "./semantic";

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
