/**
 * 清晰度档位 = 渲染分辨率相对屏幕 DPR 的倍率。
 * 像素量按分辨率平方增长，是 GPU 的大头：同样 300% 缩放下，
 * 「高」要画约 5.4 MPix/帧，「中」约 3.0，「低」约 1.4。
 * 独立成模块是为了可单测 —— live2d.ts 会连带拉进 pixi 与 Live2D 库，在 node 环境加载不了。
 */
export const RENDER_SCALE = { 高: 1, 中: 0.75, 低: 0.5 } as const;
export type RenderQuality = keyof typeof RENDER_SCALE;

export function renderResolution(quality: RenderQuality, dpr = globalThis.devicePixelRatio || 1): number {
  return Math.max(1, dpr * RENDER_SCALE[quality]);
}

/** 可选帧率。30 够用且省电，60 给「要它更跟手」的场景。 */
export const FPS_CHOICES = [30, 60] as const;
