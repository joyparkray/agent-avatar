export interface DragWindow { startDragging(): Promise<void> }
export type DragLog = (event: object) => void;

export async function startWindowDragging(window: DragWindow, log: DragLog): Promise<void> {
  try { await window.startDragging(); }
  catch (error) { log({ event: "window:drag:error", error: String(error).slice(0, 300) }); }
}

/**
 * 超过这个位移才认为是拖动。按下即拖会吞掉后续的 click / dblclick 事件，
 * 阈值越大单击越不容易被误判成拖动。
 */
export const DRAG_THRESHOLD_PX = 50;

export function exceedsDragThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

/**
 * `startDragging()` 让窗口从**当前位置**开始跟随光标，阈值前的位移会被丢弃，
 * 表现为整个拖动过程人物落后光标一个阈值的距离。`beforeDrag` 用来在交给系统前补上这段位移。
 */
export function installWindowDragging(
  root: HTMLElement, window: DragWindow, log: DragLog,
  beforeDrag?: (dx: number, dy: number) => Promise<void> | void,
): () => void {
  let origin: { x: number; y: number } | undefined;

  const onPointerMove = (event: PointerEvent) => {
    if (!origin || !exceedsDragThreshold(event.clientX - origin.x, event.clientY - origin.y)) return;
    const dx = event.clientX - origin.x, dy = event.clientY - origin.y;
    origin = undefined;
    root.removeEventListener("pointermove", onPointerMove);
    void (async () => {
      try { await beforeDrag?.(dx, dy); } catch (error) { log({ event: "window:drag:catchup-error", error: String(error).slice(0, 200) }); }
      await startWindowDragging(window, log);
    })();
  };
  const stopTracking = () => { origin = undefined; root.removeEventListener("pointermove", onPointerMove); };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest("[data-no-drag]") || event.target.hasAttribute("data-tauri-drag-region")) return;
    origin = { x: event.clientX, y: event.clientY };
    root.addEventListener("pointermove", onPointerMove);
  };

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointerup", stopTracking);
  root.addEventListener("pointercancel", stopTracking);
  return () => {
    stopTracking();
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("pointerup", stopTracking);
    root.removeEventListener("pointercancel", stopTracking);
  };
}
