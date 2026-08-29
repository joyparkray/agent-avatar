import { describe, expect, it, vi } from "vitest";
import {
  distance, GAZE_MIN_TRAVEL, GAZE_RANGE, IdleAutonomy,
  nextGazeTarget, nextIdleAction, nextIdleDelay,
} from "./idle";

describe("idle scheduling", () => {
  it("keeps the delay inside the configured range", () => {
    for (const roll of [0, 0.5, 0.999, 1, -1, Number.NaN]) {
      const delay = nextIdleDelay(() => roll, 1000, 2000);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });

  it("favours looking around over performing", () => {
    // 动作与表情都是有起止的表演，太频繁显得多动；「看看这边看看那边」才是没事做时的常态
    expect(nextIdleAction(() => 0.1)).toBe("gaze");
    expect(nextIdleAction(() => 0.7)).toBe("motion");
    expect(nextIdleAction(() => 0.9)).toBe("expression");
  });
});

describe("gaze targets", () => {
  it("stays within range, with a flatter vertical span", () => {
    const target = nextGazeTarget({ x: 0, y: 0 }, () => 1);
    expect(Math.abs(target.x)).toBeLessThanOrEqual(GAZE_RANGE);
    // 纵向压到一半：人物抬头低头幅度本来就小，满偏会翻白眼
    expect(Math.abs(target.y)).toBeLessThanOrEqual(GAZE_RANGE * 0.5 + 1e-9);
  });

  it("never returns to where it already is", () => {
    // 随机数恒定 → 每次都挑到同一个点；仍然必须挪开，否则「该动时没动」像卡住
    const current = { x: 0.5, y: 0.2 };
    const target = nextGazeTarget(current, () => 0.75);
    expect(distance(target, current)).toBeGreaterThanOrEqual(GAZE_MIN_TRAVEL);
  });
});

describe("IdleAutonomy", () => {
  const setup = () => {
    vi.useFakeTimers(); vi.stubGlobal("window", globalThis);
    const acted: string[] = [];
    const idle = new IdleAutonomy((action) => acted.push(action), { graceMs: 100, minMs: 50, maxMs: 50 }, () => 0.1);
    return { acted, idle };
  };

  it("waits out the grace period before doing anything", async () => {
    const { acted, idle } = setup();
    idle.start();
    await vi.advanceTimersByTimeAsync(90);
    expect(acted).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(acted).toEqual(["gaze"]);
    idle.stop(); vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it("pushes the next action back whenever something else is happening", async () => {
    // 自治是「没事做才做的事」，抢在正事前面就成了干扰
    const { acted, idle } = setup();
    idle.start();
    await vi.advanceTimersByTimeAsync(80);
    idle.notifyBusy();
    await vi.advanceTimersByTimeAsync(80);
    expect(acted).toEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    expect(acted).toEqual(["gaze"]);
    idle.stop(); vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it("stops firing after stop()", async () => {
    const { acted, idle } = setup();
    idle.start();
    await vi.advanceTimersByTimeAsync(110);
    idle.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(acted).toEqual(["gaze"]);
    vi.useRealTimers(); vi.unstubAllGlobals();
  });
});

describe("runtime grace changes", () => {
  it("re-times against the new grace immediately", async () => {
    // 改完设置不该等当前这一轮走完才生效 —— 那可能是半分钟
    vi.useFakeTimers(); vi.stubGlobal("window", globalThis);
    const acted: string[] = [];
    const idle = new IdleAutonomy(action => acted.push(action), { graceMs: 10_000, minMs: 50, maxMs: 50 }, () => 0.1);
    idle.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(acted).toEqual([]);
    idle.setGrace(100);
    await vi.advanceTimersByTimeAsync(120);
    expect(acted).toEqual(["gaze"]);
    idle.stop(); vi.useRealTimers(); vi.unstubAllGlobals();
  });
});
