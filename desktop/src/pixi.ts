import { loadTextures, TextureSource } from "pixi.js";

loadTextures.config = { preferWorkers: false, preferCreateImageBitmap: false, crossOrigin: "anonymous" };

/**
 * 纹理生成 mipmap。**这是官方对「缩小时线条粗糙、有锯齿」的标准答案**。
 *
 * 全身构图下模型被缩到约 1/10（实测 hiyori 2976×4175 → 313×440），一个屏幕像素要代表纹理上
 * 十来个像素。没有 mipmap 时 GPU 只能最近点抽样，Live2D 官方原话：
 * 「The switching occurs sharply when drawing without mipmaps, giving the impression that
 * antialiasing is ineffective, that lines are rough, and that jaggies are present.」
 * （docs.live2d.com/en/cubism-sdk-manual/texture-trouble-shooting/，官方给的做法是
 * 缩小用 `LINEAR_MIPMAP_LINEAR`、放大用 `LINEAR`，并调 `glGenerateMipmap`。）
 * 聚焦模式下模型被放大，走的是放大路径，所以边缘一直是清晰的 —— 正是这个差别的来源。
 *
 * Pixi 8 侧对应的就是这一个开关：`autoGenerateMipmaps` 会算出 mipLevelCount、上传后调
 * `generateMipmap`，并把 MIN_FILTER 设成 LINEAR_MIPMAP_LINEAR（见 GlTextureSystem 与
 * applyStyleParams）。官方文档：「Mipmapped textures take up more memory, but can look
 * better when scaled down.」代价是每张纹理多约 33% 显存。
 *
 * **设成全局默认而不是逐张改**：mipLevelCount 在首次上传时就定死了，纹理由库自己创建，
 * 我们拿到它时已经传上 GPU，再改开关不会重新分配层级。RenderTexture 不受影响 ——
 * TexturePool 建它们时显式传了这个参数（官方也明确不建议给逐帧更新的 RenderTexture 开 mipmap）。
 */
TextureSource.defaultOptions.autoGenerateMipmaps = true;

/**
 * Cubism Core 5 起把渲染顺序从 `drawables.renderOrders` 挪到了 `Model.getRenderOrders()`
 * （官方 Framework 5 的 `CubismModel.getRenderOrders` 正是这么对上的，见 Core 的 .d.ts：
 * `Drawables` 里已经没有 renderOrders 了）。pixi-live2d-display 1.4.0 打包的是
 * Cubism 4 Framework，仍读旧字段，于是每帧 `renderOrder[i]` 取到 undefined 直接抛。
 *
 * 新口径的数组长度是 **drawable + offscreen**，序号在两者之间统一排；而老渲染器把它当成
 * `0..drawableCount-1` 的稠密索引直接写进 `_sortedDrawableIndexList`（见其 doDrawModel）。
 * 直接透传会让含 offscreen 的模型越界写，一部分 drawable 永远轮不到画 —— 所以这里把
 * drawable 那一段压回稠密排名，相对顺序与官方一致。
 *
 * ponytail: offscreen 本身（Cubism 5.1+ 的离屏合成）老框架画不了，这里只保证「该画的都画上、
 * 前后关系不乱」。要完整支持得换成基于 Cubism Framework 5 的渲染器。
 *
 * 旧 Core 上 `renderOrders` 字段本来就在，`in` 判断会让补丁自动让位 —— 两个版本都能跑。
 */
const core = (globalThis as { Live2DCubismCore?: { Model?: { fromMoc?: (moc: unknown) => unknown } } }).Live2DCubismCore;
if (core?.Model?.fromMoc) {
  const fromMoc = core.Model.fromMoc.bind(core.Model);
  core.Model.fromMoc = (moc: unknown) => {
    const model = fromMoc(moc) as
      { drawables?: { count: number }; getRenderOrders?: () => Int32Array } | null;
    if (model?.drawables && model.getRenderOrders && !("renderOrders" in model.drawables)) {
      const count = model.drawables.count;
      const ranked = new Int32Array(count);
      const indices = Array.from({ length: count }, (_, index) => index);
      Object.defineProperty(model.drawables, "renderOrders", {
        get: () => {
          const orders = model.getRenderOrders!();
          indices.sort((a, b) => orders[a] - orders[b]);
          for (let rank = 0; rank < count; rank++) ranked[indices[rank]] = rank;
          return ranked;
        },
      });
    }
    return model;
  };
}
