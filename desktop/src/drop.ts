/**
 * 这一次拖放事件里「真的放下了」的路径；其余一律 null。
 *
 * 🔴 **`enter` 也带 `paths`**（webview.d.ts 里 enter 与 drop 的载荷同形）。原来的写法是
 * 「不是 over/leave 就当作放下」，于是文件夹刚飘进窗口就装了一次，用户真正松手时再装一次 ——
 * 第二次撞上「已经装过 xxx」，屏幕上就只剩那句错误。实机报障正是「拖完立刻提示已安装」。
 */
export function droppedPath(payload: { type: string; paths?: string[] }): string | null {
  return payload.type === "drop" ? payload.paths?.[0] ?? null : null;
}

