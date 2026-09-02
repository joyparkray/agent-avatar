//! 命中网格：把渲染结果的 alpha 通道压成一张位图，供 Rust 侧做光标命中判定。
//! 纯计算、不碰 Pixi —— 位序是两边各写一遍的东西，得能单独测。

/**
 * 命中网格一格多少 CSS 像素。8px 一格：374×484 的窗口约 47×61 格 ≈ 359 字节，
 * 每次上报多传这么点、每格的误差不到半个指尖，桌宠够用。
 */
export const HIT_CELL_PX = 8;
/**
 * 隔多久重算一次命中网格。
 *
 * 网格因此比画面滞后一拍（挥手时边缘略滞后），桌宠可以接受；换来的是判定仍然全在 Rust 侧、
 * 仍然是查表，没有为此增加任何 IPC 往返，故首击延迟不受影响。
 */
export const HIT_SAMPLE_MS = 400;
/**
 * 低于这个 alpha 的格子算空白。
 *
 * **取得低是有意的。** 马尾、手指、发梢这类细节降采样后 alpha 很低，阈值一高就整片消失，
 * 表现是「人物身上有一块点不动」——比多留一格空白难受得多。宁可命中松一点。
 */
const HIT_ALPHA = 0.12;

/** 外接矩形加盒内占位网格。 */
export type HitMask = { x: number; y: number; width: number; height: number; cols: number; rows: number; bits: number[] };
/** 命中区域：网格是可选的 —— 抽不出像素时退回只有矩形的老行为。 */
export type HitArea = Omit<HitMask, "cols" | "rows" | "bits"> & Partial<Pick<HitMask, "cols" | "rows" | "bits">>;

/**
 * 把一张低分辨率 RGBA 图的 alpha 通道打包成命中区域：不透明格子的外接矩形 + 盒内位图。
 *
 * **位序必须和 Rust 侧 `hit_test::Mask` 一致：行主序、每字节低位在前。**
 * 两边各写了一遍，对不上的表现不是报错，而是桌宠整只点不动或者整只点不穿，
 * 所以两边各留了一条用同一个向量的回归用例。
 *
 * `width`/`height` 是这张图覆盖的 CSS 像素范围（通常就是窗口），用来把格子换算回 CSS 坐标。
 * 一格都没亮时返回 `undefined`，让调用方决定怎么兜底。
 */
export function packHitMask(pixels: Uint8ClampedArray, cols: number, rows: number, width: number, height: number): HitMask | undefined {
  if (cols <= 0 || rows <= 0 || pixels.length < cols * rows * 4) return undefined;
  const cutoff = HIT_ALPHA * 255;
  let minCol = cols, minRow = rows, maxCol = -1, maxRow = -1;
  const solid = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cell = row * cols + col;
      if (pixels[cell * 4 + 3] < cutoff) continue;
      solid[cell] = 1;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }
  }
  if (maxCol < 0) return undefined;

  // 用**实际**的格子边长：frame 除不尽时 Pixi 会取整，直接拿 HIT_CELL_PX 会累积出偏移。
  const cellWidth = width / cols, cellHeight = height / rows;
  const maskCols = maxCol - minCol + 1, maskRows = maxRow - minRow + 1;
  const bits = new Array<number>(Math.ceil((maskCols * maskRows) / 8)).fill(0);
  for (let row = 0; row < maskRows; row += 1) {
    for (let col = 0; col < maskCols; col += 1) {
      if (!solid[(row + minRow) * cols + (col + minCol)]) continue;
      const index = row * maskCols + col;
      bits[index >> 3] |= 1 << (index & 7);
    }
  }
  return {
    x: minCol * cellWidth, y: minRow * cellHeight,
    width: maskCols * cellWidth, height: maskRows * cellHeight,
    cols: maskCols, rows: maskRows, bits,
  };
}
