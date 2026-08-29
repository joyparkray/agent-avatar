import { readFileSync } from "node:fs";
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

/**
 * 回归：全身构图把模型缩到约 1/10，没有 mipmap 时 Live2D 官方描述的症状就会出现
 * （「lines are rough … jaggies are present」，见 pixi.ts 的引文）。聚焦模式走放大路径，
 * 所以只有全身模式糊 —— 这个差别就是缺 mipmap 的指纹。
 * 开关一旦被删，画面退化只能靠眼睛发现，故在这里钉住。
 */
describe("texture mipmaps", () => {
  const source = readFileSync("src/pixi.ts", "utf8");

  it("turns on mipmap generation before any texture is created", () => {
    expect(source).toMatch(/TextureSource\.defaultOptions\.autoGenerateMipmaps\s*=\s*true/);
    // 必须在模块顶层执行：库自己创建纹理，晚于上传再改开关不会重新分配 mip 层级
    expect(source.indexOf("autoGenerateMipmaps")).toBeLessThan(source.indexOf("Live2DCubismCore"));
  });

  it("logs the mip level count so a silent regression is visible", () => {
    const source = readFileSync("src/live2d.ts", "utf8");
    expect(source).toContain("model:textures");
    // 纹理挂在 Live2DModel 上，不在 internalModel 上；取错地方这条探针恒为 count:0（实测踩到）
    expect(source).toMatch(/this\.model as unknown as \{ textures\?/);
  });
});
