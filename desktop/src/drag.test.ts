import { describe, expect, it, vi } from "vitest";
import { DRAG_THRESHOLD_PX, exceedsDragThreshold, startWindowDragging } from "./drag";

describe("command window dragging", () => {
  it("calls the Tauri command path", async () => {
    const startDragging = vi.fn().mockResolvedValue(undefined), log = vi.fn();
    await startWindowDragging({ startDragging }, log);
    expect(startDragging).toHaveBeenCalledOnce(); expect(log).not.toHaveBeenCalled();
  });
  it("logs a failed drag without throwing", async () => {
    const log = vi.fn();
    await startWindowDragging({ startDragging: vi.fn().mockRejectedValue(new Error("denied")) }, log);
    expect(log).toHaveBeenCalledWith({ event: "window:drag:error", error: "Error: denied" });
  });
});

// 按下即拖会吞掉 click / dblclick；双击摸头依赖这个阈值。
describe("drag threshold", () => {
  it("ignores the jitter of a plain click but accepts a real drag", () => {
    expect(exceedsDragThreshold(0, 0)).toBe(false);
    expect(exceedsDragThreshold(20, 20)).toBe(false);
    expect(exceedsDragThreshold(DRAG_THRESHOLD_PX, 0)).toBe(true);
    expect(exceedsDragThreshold(-40, -40)).toBe(true);
  });
});
