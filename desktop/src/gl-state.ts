export interface ClearColorContext { clearColor(red: number, green: number, blue: number, alpha: number): void }

/**
 * Cubism 用裸 GL 调 `clearColor(1, 1, 1, 0)` 清遮罩缓冲，改掉了 Pixi 缓存的全局 GL 状态。
 * Pixi 下一帧 `renderStart` 判定 clear color 未变、跳过 `clearColor`，于是用 Cubism 留下的
 * 白色清画布：透明背景变成 (255,255,255,0)，半透明边缘合成时漏白 —— 即人物白边。
 * 每帧 Live2D 画完后还原成 Pixi 认为的值（`backgroundAlpha: 0` → 全 0）。
 */
export function restoreClearColor(renderer: unknown): void {
  (renderer as { gl?: ClearColorContext } | null)?.gl?.clearColor(0, 0, 0, 0);
}
