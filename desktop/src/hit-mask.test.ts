import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { packHitMask } from "./hit-mask";

/** 用 alpha 图案造一张 RGBA 图：`rows` 里每个字符 `#` = 不透明，`.` = 透明。 */
function image(rows: string[]): { pixels: Uint8ClampedArray; cols: number; rows: number } {
  const cols = rows[0].length;
  const pixels = new Uint8ClampedArray(cols * rows.length * 4);
  rows.forEach((line, row) => [...line].forEach((cell, col) => {
    pixels[(row * cols + col) * 4 + 3] = cell === "#" ? 255 : 0;
  }));
  return { pixels, cols, rows: rows.length };
}

describe("命中网格", () => {
  it("外接矩形只框住不透明的格子", () => {
    // 4x4 的图，人物只占中间 2x2 —— 这就是「模型声明的画布远大于人物」的缩影
    const { pixels, cols, rows } = image([
      "....",
      ".##.",
      ".##.",
      "....",
    ]);
    const area = packHitMask(pixels, cols, rows, 40, 40)!;
    expect(area).toMatchObject({ x: 10, y: 10, width: 20, height: 20, cols: 2, rows: 2 });
  });

  /**
   * **位序必须和 Rust 侧 `hit_test::Mask` 一致：行主序、每字节低位在前。**
   * 下面这两个向量在 `hit_test.rs` 的用例里逐位重复了一遍；改一边就会有一边红。
   */
  it("按行主序、低位在前打包，与 Rust 侧同一套向量", () => {
    // 右上 + 左下 → 位 1 与位 2
    const diagonal = image([".#", "#."]);
    expect(packHitMask(diagonal.pixels, diagonal.cols, diagonal.rows, 2, 2)!.bits).toEqual([0b0000_0110]);
    // 中间一格空 → 位 0 与位 2
    const hole = image(["#.#"]);
    expect(packHitMask(hole.pixels, hole.cols, hole.rows, 3, 1)!.bits).toEqual([0b0000_0101]);
  });

  it("盒内的空洞留成 0，穿透靠的就是这些位", () => {
    // 一个「人」字形：两腿之间是空的
    const { pixels, cols, rows } = image([
      "###",
      "#.#",
    ]);
    const area = packHitMask(pixels, cols, rows, 30, 20)!;
    expect(area.cols * area.rows).toBe(6);
    // 位 4（第二行中间）是唯一的 0
    expect(area.bits).toEqual([0b0010_1111]);
  });

  it("位数按 cols*rows 向上取整到字节，Rust 侧据此校验长度", () => {
    const wide = image([".".repeat(9).replace(/./g, "#")]);
    const area = packHitMask(wide.pixels, wide.cols, wide.rows, 90, 10)!;
    expect(area.cols).toBe(9);
    expect(area.bits).toHaveLength(2);
    expect(area.bits).toEqual([0b1111_1111, 0b0000_0001]);
  });

  it("半透明边缘算命中 —— 漏掉发梢比多挡一格难受得多", () => {
    const { pixels, cols, rows } = image(["#."]);
    pixels[1 * 4 + 3] = 40;   // 约 0.16 alpha，高于 0.12 的门槛
    expect(packHitMask(pixels, cols, rows, 20, 10)!.cols).toBe(2);
    pixels[1 * 4 + 3] = 20;   // 约 0.08，低于门槛
    expect(packHitMask(pixels, cols, rows, 20, 10)!.cols).toBe(1);
  });

  it("一格都不亮时返回 undefined，由调用方兜底成整个包围盒", () => {
    const blank = image(["..", ".."]);
    expect(packHitMask(blank.pixels, blank.cols, blank.rows, 20, 20)).toBeUndefined();
    expect(packHitMask(new Uint8ClampedArray(0), 0, 0, 10, 10)).toBeUndefined();
    // 像素比声明的尺寸少 —— 读越界会静默给出错误的网格，这里必须拒掉
    expect(packHitMask(new Uint8ClampedArray(4), 4, 4, 10, 10)).toBeUndefined();
  });

  /** 两边的打包规则各写了一遍，靠这条把「另一边也确实这么写」钉在测试里。 */
  it("Rust 侧留着同一组向量", () => {
    const rust = readFileSync(new URL("../src-tauri/src/hit_test.rs", import.meta.url), "utf8");
    expect(rust).toContain("0b0000_0110");
    expect(rust).toContain("0b0000_0101");
  });
});
