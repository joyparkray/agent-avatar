import { describe, expect, it } from "vitest";
import { RENDER_SCALE, renderResolution, type RenderQuality } from "./render-quality";

// 像素量按分辨率平方增长，档位数值写错等于白省。
describe("renderResolution", () => {
  it("scales the buffer down tier by tier on retina", () => {
    expect(renderResolution("高", 2)).toBe(2);
    expect(renderResolution("中", 2)).toBe(1.5);
    expect(renderResolution("低", 2)).toBe(1);
  });
  it("never drops below 1 even on a non-retina screen", () => {
    expect(renderResolution("低", 1)).toBe(1);
    expect(renderResolution("中", 1)).toBe(1);
  });
  it("keeps the tiers strictly ordered", () => {
    const tiers = Object.keys(RENDER_SCALE) as RenderQuality[];
    const scales = tiers.map(tier => RENDER_SCALE[tier]);
    expect(scales).toEqual([...scales].sort((a, b) => b - a));
  });
});
