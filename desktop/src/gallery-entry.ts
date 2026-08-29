/**
 * 画廊的入口。**必须是模块**（`<script type="module" src=...>`），与主窗口的 entry.ts 同形。
 *
 * 原来这段逻辑写在 gallery.html 的**普通内联脚本**里。Vite 不会把普通脚本里的动态 import
 * 当成模块打包，而是把 `/src/gallery.ts` 原样拷成 `dist/assets/gallery-<hash>.ts` ——
 * 发布版的静态服务器按扩展名给 MIME，`.ts` 落进 `application/octet-stream`，
 * 浏览器的严格 MIME 检查直接拒绝加载模块，**画廊变成一片黑**（dev 下由 Vite 现编译，
 * 所以只在发布版复现，2026-08-29 实机撞到）。
 *
 * Cubism Core 必须在 gallery.ts 之前就位：Live2D 库在 import 时就要读全局的 `Live2DCubismCore`。
 */
// `export {}`：没有 import/export 的 .ts 会被 TS 当成全局脚本，顶层的 `core` 就和 entry.ts
// 里的同名变量撞车（TS2451）。声明成模块，作用域各归各的。
export {};

const core = document.createElement("script");
core.src = "/vendor/live2d-core/live2dcubismcore.min.js";
core.onload = () => void import("./gallery");
core.onerror = () => {
  const box = document.getElementById("err");
  if (box) box.textContent = "Cubism Core failed to load / Cubism Core 加载失败";
  console.error("Cubism Core failed to load");
};
document.head.append(core);
