export type Framing = "full" | "focus";

/**
 * 聚焦模式的**默认**放大倍数（用户可在设置里改，见 prefs 的 focusPercent）。
 * 3 倍 = 只见模型顶部三分之一；对全身模型正好是头+肩+上胸，
 * 但 2/3 身的模型本来就只画到腰，按 3 倍裁会只剩一个头 —— 所以这只是默认值，不是定论。
 */
export const FOCUS_ZOOM = 3;
/** 聚焦模式里头顶留白。 */
export const FOCUS_TOP_MARGIN = 12;
/**
 * 判定「模型本身已是胸像」的宽高比。全身模型普遍在 0.5~0.75（Haru 0.53、Hiyori 0.71），
 * 胸像模型接近或大于 1，两类差距很大不会误判。
 * 注意：**不能**反过来用包围盒推算「该放大多少」—— 宽度会被张开的手臂与头发撑大，
 * Hiyori 明显比 Haru 宽却同为全身，按比例算出来的裁切量不可信。
 */
export const FOCUS_SKIP_ASPECT = 0.9;

export interface FrameBox { x: number; y: number; scale: number }

/**
 * 聚焦模式：按 `zoom` 放大，并把模型顶端对齐到窗口上缘（留 `topMargin`），
 * 身体溢出窗口下缘后被 canvas 裁掉 —— 这正是「只露上半身」的效果，不需要遮罩。
 */
export function focusFrame(
  baseHeight: number, fitScale: number, hostWidth: number, zoom = FOCUS_ZOOM, topMargin = FOCUS_TOP_MARGIN,
): FrameBox {
  const scale = fitScale * zoom;
  return { x: hostWidth / 2, y: topMargin + (baseHeight * scale) / 2, scale };
}

/** 已经是胸像的模型不该再裁，按 fit 显示即可。 */
export function autoFocusZoom(
  baseWidth: number, baseHeight: number, zoom = FOCUS_ZOOM, bustAspect = FOCUS_SKIP_ASPECT,
): number {
  return baseHeight > 0 && baseWidth / baseHeight >= bustAspect ? 1 : zoom;
}

/**
 * 吸附底边时窗口左上角应有的 y。基准取**显示器下缘**而非工作区下缘 ——
 * 工作区会排除 Dock 与菜单栏，吸过去会在人物下方留出一条可见空隙。
 */
export function bottomSnapY(areaTop: number, areaHeight: number, windowHeight: number): number {
  return areaTop + areaHeight - windowHeight;
}
