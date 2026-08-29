import { describe, expect, it } from "vitest";
import { bottomSnapY, focusFrame, autoFocusZoom } from "./dock";

describe("focusFrame", () => {
  // Haru：2400×4500，窗口 340×440 → fitScale ≈ 0.0978，3 倍放大后窗口内可见约顶部三分之一。
  const fitScale = Math.min(340 / 2400, 440 / 4500);

  it("centres horizontally and hangs the body below the window", () => {
    const frame = focusFrame(4500, fitScale, 340, 3, 12);
    expect(frame.x).toBe(170);
    expect(frame.scale).toBeCloseTo(fitScale * 3, 6);
    // 锚点在中心，故顶端 = y - 高/2，应恰好落在留白处
    expect(frame.y - (4500 * frame.scale) / 2).toBeCloseTo(12, 6);
  });
  it("shows roughly the top third of the model at 3x", () => {
    const visible = 440 / (4500 * focusFrame(4500, fitScale, 340, 3, 12).scale);
    expect(visible).toBeGreaterThan(0.28);
    expect(visible).toBeLessThan(0.38);
  });
  it("shows less of the model as the zoom grows", () => {
    const visible = (zoom: number) => 440 / (4500 * focusFrame(4500, fitScale, 340, zoom).scale);
    expect(visible(5)).toBeLessThan(visible(3));
  });
});

describe("autoFocusZoom", () => {
  it("crops full-body models", () => {
    expect(autoFocusZoom(2400, 4500)).toBe(3);   // Haru 0.53
    expect(autoFocusZoom(2976, 4175)).toBe(3);   // Hiyori 0.71 —— 手臂与头发撑宽，但仍是全身
  });
  it("leaves models that are already a focus alone", () => {
    expect(autoFocusZoom(1000, 1000)).toBe(1);
    expect(autoFocusZoom(1400, 1000)).toBe(1);
  });
  it("switches at the focus aspect ratio", () => {
    expect(autoFocusZoom(89, 100)).toBe(3);
    expect(autoFocusZoom(90, 100)).toBe(1);
  });
  it("tolerates a degenerate model size", () => {
    expect(autoFocusZoom(100, 0)).toBe(3);
  });
});

describe("bottomSnapY", () => {
  it("aligns the window bottom with the given area bottom", () => {
    expect(bottomSnapY(25, 1000, 440)).toBe(585);
    expect(bottomSnapY(25, 1000, 440) + 440).toBe(25 + 1000);
  });
  // 传显示器下缘而非工作区下缘：后者排除 Dock，会在人物下方留一条空隙。
  it("puts the window lower when given the screen bottom instead of the work area", () => {
    const screen = bottomSnapY(0, 1080, 440);
    const work = bottomSnapY(25, 1080 - 25 - 70, 440);
    expect(screen).toBeGreaterThan(work);
  });
  it("allows a window taller than the area to overflow upwards", () => {
    expect(bottomSnapY(0, 400, 600)).toBe(-200);
  });
});
