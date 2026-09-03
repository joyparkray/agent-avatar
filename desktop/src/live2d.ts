import "./pixi";
import { Application, RendererType, UPDATE_PRIORITY } from "pixi.js";
import { Live2DModel, MotionPriority } from "@jannchie/pixi-live2d-display/cubism4";
import { loadManifest } from "./manifest";
import { restoreClearColor } from "./gl-state";
import { renderResolution, type RenderQuality } from "./render-quality";
import { focusFrame, autoFocusZoom, FOCUS_ZOOM, type Framing } from "./dock";
import { HIT_CELL_PX, HIT_SAMPLE_MS, packHitMask, type HitArea } from "./hit-mask";

/**
 * 渲染口径均已定案，故写死为常量而非可调开关：
 * - `antialias: false` —— MSAA 会在透明边缘生成额外的半透明亮色覆盖像素
 * - `premultipliedAlpha: true` —— 与 Cubism 的预乘链路一致，**不得改为 false**
 * - `resolution` 由菜单的清晰度档位决定，见 RENDER_SCALE
 * - `gcActive: false` —— Live2D 手工绑定的纹理会被 Pixi GC 在约 60 秒后回收
 */
const RENDER = { antialias: false, premultipliedAlpha: true, preference: "webgl", gcActive: false } as const;
export const MAX_RENDER_FPS = 30;
import type { AvatarManifest, AvatarModel, AvatarSource, EmotionCue, Reaction, SemanticState } from "./types";
import { resolveForState, resolveSemanticMotion } from "./types";

/** 单击/菜单播放的表情停留多久后回到中性脸。语义状态设的表情不受此影响。 */
export const EXPRESSION_REVERT_MS = 4000;

function watchResize(target: HTMLElement, onResize: () => void): () => void {
  const observer = new ResizeObserver(() => onResize());
  observer.observe(target);
  return () => observer.disconnect();
}

/** pixi-live2d-display 的内部模型：这两个成员没有公开类型，但都是稳定 API。 */
interface InternalModelWithUpdate {
  update(deltaSeconds: number, now: number): void;
  coreModel: {
    setParameterValueById(id: string, value: number): void;
    getParameterIndex(id: string): number;
    getParameterDefaultValue(index: number): number;
  };
}

export class Live2DAvatarModel implements AvatarModel {
  private app?: Application; private model?: Live2DModel; private manifest?: AvatarManifest; private removeContextListeners?: () => void; private renderCount = 0; private baseSize: [number, number] = [1, 1]; private stopResizeWatch?: () => void; private expressionRevert?: number; private framing: Framing = "full";
  private semanticMotions: Partial<Record<SemanticState, [string, number]>> = {};
  private semanticExpressions: Partial<Record<SemanticState, string>> = {};
  private focusZoomBase = FOCUS_ZOOM;
  /** 用户是否在设置里显式调过。调过就以他为准，不再让自动判断插手。 */
  private focusZoomExplicit = false;
  get manifestId(): string | undefined { return this.manifest?.id; }
  constructor(private readonly host: HTMLElement, private readonly log: (event: object) => void = console.info) {}
  async load(source: AvatarSource): Promise<void> {
    this.manifest = await loadManifest(source);
    this.log({ event: "pixi:application:before", hostWidth: this.host.clientWidth, hostHeight: this.host.clientHeight });
    this.app = new Application(); this.log({ event: "pixi:application:created" });
    // pixi-live2d-display 1.4.0 still touches the pre-8.15 `source.touched` field. Its manually-bound
    // textures otherwise look unused to Pixi 8.20 and are deleted after gcMaxUnusedTime (60s).
    await this.app.init({ resizeTo: this.host, autoDensity: true, backgroundAlpha: 0, resolution: renderResolution(this.quality), ...RENDER });
    this.app.ticker.maxFPS = MAX_RENDER_FPS;
    const canvas = this.app.canvas, renderer = this.app.renderer;
    const onContextLost = (event: Event) => this.log({ event: "webgl:contextlost", defaultPrevented: event.defaultPrevented });
    const onContextRestored = () => this.log({ event: "webgl:contextrestored" });
    canvas.addEventListener("webglcontextlost", onContextLost); canvas.addEventListener("webglcontextrestored", onContextRestored);
    this.removeContextListeners = () => { canvas.removeEventListener("webglcontextlost", onContextLost); canvas.removeEventListener("webglcontextrestored", onContextRestored); };
    this.log({ event: "pixi:renderer:initialized", type: RendererType[renderer.type], canvasWidth: canvas.width, canvasHeight: canvas.height, maxFPS: this.app.ticker.maxFPS, contextLostListener: true });
    this.host.append(canvas);
    this.model = await Live2DModel.from(`${source.baseUrl}/${this.manifest.model}`, { ticker: this.app.ticker, autoInteract: false });
    this.log({ event: "model:from:complete", width: this.model.width, height: this.model.height });
    // 库的 lipSyncEnabled 默认为 false —— 不开这一项，lipSyncValue 根本不会被应用
    (this.model.internalModel as unknown as { setLipSyncEnabled?(on: boolean): void }).setLipSyncEnabled?.(true);
    this.installPhysicalViewport();
    this.instrumentMotionManager();
    const live2dRender = this.model.onRender;
    this.model.onRender = renderer => {
      this.renderCount++;
      live2dRender?.(renderer);
      restoreClearColor(renderer);
    };
    this.log({ event: "model:stage:before", width: this.model.width, height: this.model.height, stageChildren: this.app.stage.children.length });
    this.baseSize = [this.model.width, this.model.height];
    this.model.anchor.set(0.5, 0.5); this.fit();
    // 缩放走窗口尺寸，模型始终 fit-to-window，故窗口变化后必须重新适配。
    this.stopResizeWatch = watchResize(this.host, () => this.fit());
    this.app.stage.addChild(this.model); this.startHitSampling(); this.log({ event: "model:stage:after", width: this.model.width, height: this.model.height, stageChildren: this.app.stage.children.length });
    // mipLevelCount 是首帧上传时才算出来的，故等一帧再记。>1 = mipmap 生效（见 pixi.ts 的说明）；
    // 恒为 1 时全身构图会重新变回「线条粗糙、断断续续的锯齿」，而那是个只能靠眼睛发现的退化。
    requestAnimationFrame(() => this.log({ event: "model:textures", ...this.textureSnapshot() }));
  }
  /**
   * 嘴型走库自带的口型通道，而不是直接写 `ParamMouthOpenY`。
   * 直接写会失效：`InternalModel.update()` 的顺序是 motion → saveParameters → …，
   * 我们在音频回调里异步设的值会被下一帧 `motionManager.update()` 连同 idle 动作一起覆盖掉。
   * `lipSyncValue` 由库在 motion 之后以 0.8 权重叠加，且作用于模型 `model3.json` 声明的
   * LipSync 参数组（Haru 与 Hiyori 均为 ParamMouthOpenY），比硬编码参数名更贴合可插拔形象。
   */
  /**
   * 状态角标的辉光（模糊半径 8→30px）由 `--vocal` 驱动，写一次就是一次全文档样式失效 + 阴影重栅格化。
   * 音频回调约 93 次/秒（CoreAudio 512 帧缓冲 @48k），远超帧率 —— 视觉上根本看不出差别，
   * 故限频到 20Hz 并跳过无意义的微小变化。嘴型本身走 lipSyncValue，不受此限制。
   */
  private lastGlowAt = 0;
  private lastGlow = -1;
  private updateGlow(level: number): void {
    const quantized = Math.round(level * 20) / 20;
    const now = performance.now();
    if (quantized === this.lastGlow || now - this.lastGlowAt < 50) return;
    this.lastGlow = quantized;
    this.lastGlowAt = now;
    document.documentElement.style.setProperty("--vocal", String(quantized));
  }
  /**
   * 张嘴幅度倍率。1 = 原样。
   *
   * 放在这里是因为 `setVocalLevel` 是**三种音源唯一都经过的那个点**
   * （global/file 经 AudioSourceController，hermes 经 VoiceDriver，最后都落到这儿）——
   * 挂在别处就得挂三份，而漏一份的表现是「换个音源幅度就不对了」。
   *
   * 各家模型的 `ParamMouthOpenY` 幅度差别很大，有的模型天生张得很小；
   * 这个倍率就是给用户把它拉到看得出来的程度。
   */
  private mouthAmplitude = 1;

  setMouthAmplitude(multiplier: number): void {
    this.mouthAmplitude = Math.max(0, multiplier);
  }

  setVocalLevel(level: number): void {
    const clamped = Math.max(0, Math.min(1, level * this.mouthAmplitude));
    const internal = this.model?.internalModel as unknown as { setLipSyncValue?(value: number): void } | undefined;
    internal?.setLipSyncValue?.(clamped);
    this.updateGlow(clamped);
  }
  playSemantic(state: SemanticState, applyExpression = true): void {
    if (!this.model || !this.manifest) return;
    this.cancelExpressionRevert();
    const motion = resolveSemanticMotion(this.semanticMotions, this.manifest.motions, state);
    if (!motion) { this.log({ event: "model:motion:missing", state }); return; }
    const [group, index] = motion;
    void this.model.motion(group, index).then(started => this.log({ event: "model:motion", state, group, index, started })).catch(error => this.log({ event: "model:motion:error", state, group, index, error: String(error) }));
    if (!applyExpression) return;
    if (state === "idle") { this.resetExpression(); return; }
    // 用户配的优先于模型清单里作者写的 —— 界面上能选的东西必须真的生效，
    // 否则「设了没反应」比根本不给选更让人困惑。
    const expression = this.semanticExpressions[state] ?? resolveForState(this.manifest.expressions, state);
    if (expression) this.playExpression(expression, 0); else this.resetExpression();
  }
  playReaction(reaction: Reaction, durationMs: number): void {
    const expression = this.manifest?.reactions?.[reaction];
    if (expression) this.playExpression(expression, 0);
    const shell = this.host.closest<HTMLElement>(".shell");
    if (shell) { delete shell.dataset.reaction; void shell.offsetWidth; shell.dataset.reaction = reaction; shell.style.setProperty("--reaction-ms", `${durationMs}ms`); }
    this.log({ event: "model:reaction", reaction, expression: expression ?? null, durationMs });
  }
  private instrumentMotionManager(): void {
    const motionManager = this.model?.internalModel?.motionManager;
    if (!motionManager) return;
    motionManager.on("motionStart", (group: string, index: number) => this.log({ event: "motion:start", group, index }));
    motionManager.on("motionFinish", () => this.log({ event: "motion:finish" }));
  }
  private installPhysicalViewport(): void {
    // pixi-live2d-display 1.4.0 reads Pixi 8's logical renderer width for its raw Cubism
    // WebGL viewport. On Retina that renders into only one quadrant of the physical buffer.
    const internal = this.model!.internalModel as unknown as { viewport: number[]; draw(gl: WebGLRenderingContext | WebGL2RenderingContext): void };
    const draw = internal.draw.bind(internal);
    internal.draw = gl => {
      internal.viewport[2] = gl.drawingBufferWidth;
      internal.viewport[3] = gl.drawingBufferHeight;
      draw(gl);
    };
  }
  /** 纹理尺寸与 mipmap 层级。缩小绘制的清晰度全看这两项。 */
  private textureSnapshot(): object {
    // 纹理挂在 **Live2DModel 上**（库的 d.ts：`textures: Texture[]`），不在 internalModel 上。
    // 取错地方时这条日志恒为 count:0 —— 看起来像 mipmap 没生效，实际是探针自己坏了（实测踩到）。
    const textures = (this.model as unknown as { textures?: { source?: { width: number; height: number; mipLevelCount: number } }[] })?.textures ?? [];
    const first = textures[0]?.source;
    return { count: textures.length, size: first ? [first.width, first.height] : null, mipLevels: first?.mipLevelCount ?? null, resolution: renderResolution(this.quality) };
  }
  private live2dSnapshot(): object {
    const internal = this.model!.internalModel!, motion = internal.motionManager, state = motion.state;
    const core = internal.coreModel as unknown as { getModelOpacity?: () => number; getModelOpacityValue?: () => number; getPartCount?: () => number; getPartOpacityByIndex?: (index: number) => number; getParameterCount?: () => number; getParameterValueByIndex?: (index: number) => number };
    const partCount = core.getPartCount?.() ?? 0, parameterCount = core.getParameterCount?.() ?? 0;
    const expressionManager = (internal.motionManager as unknown as { expressionManager?: { currentExpression?: unknown } })?.expressionManager;
    return { motion: { group: state.currentGroup, index: state.currentIndex, priority: state.currentPriority, isFinished: motion.isFinished(), playing: motion.playing }, modelOpacity: core.getModelOpacity?.() ?? core.getModelOpacityValue?.() ?? this.model!.alpha, expression: expressionManager?.currentExpression ? String(expressionManager.currentExpression) : null, partOpacity: Array.from({ length: Math.min(partCount, 16) }, (_, index) => core.getPartOpacityByIndex?.(index)), paramOpacity: Array.from({ length: Math.min(parameterCount, 16) }, (_, index) => core.getParameterValueByIndex?.(index)) };
  }
  applyEmotion(cue: EmotionCue | null): void {
    const shell = this.host.closest<HTMLElement>(".shell");
    if (shell) shell.dataset.emotion = cue ?? "";
  }
  /** 按当前窗口尺寸重新适配模型（居中 + 等比铺满）。 */
  fit(): void {
    if (!this.model) return;
    const [width, height] = this.baseSize, hostWidth = this.host.clientWidth, hostHeight = this.host.clientHeight;
    if (!hostWidth || !hostHeight) return;
    const fitScale = Math.min(hostWidth / width, hostHeight / height);
    if (this.framing === "focus") {
      // 自动判断（宽高比 ≥ 0.9 视为「本来就是胸像」，不再裁）只在用户没表态时生效 ——
      // 否则他拖了滑块却毫无变化，比裁错更让人困惑。
      const zoom = this.focusZoomExplicit ? this.focusZoomBase : autoFocusZoom(width, height, this.focusZoomBase);
      const frame = focusFrame(height, fitScale, hostWidth, zoom);
      this.model.position.set(frame.x, frame.y);
      this.model.scale.set(frame.scale);
      return;
    }
    this.model.position.set(hostWidth / 2, hostHeight / 2 + 20);
    this.model.scale.set(Math.floor(fitScale * height) / height);
  }
  private quality: RenderQuality = "高";
  /** 运行时切清晰度：Pixi 的 resize 第三参支持改 resolution，改完要重新适配构图。 */
  setQuality(quality: RenderQuality): void {
    this.quality = quality;
    if (!this.app) return;
    this.app.renderer.resize(this.host.clientWidth, this.host.clientHeight, renderResolution(quality));
    this.fit();
    this.log({ event: "render:quality", quality, resolution: renderResolution(quality) });
  }
  setMaxFPS(fps: number): void {
    if (!this.app) return;
    this.app.ticker.maxFPS = fps;
    this.log({ event: "render:fps", fps });
  }
  /**
   * 眼睛跟随光标。坐标为窗口局部 CSS 像素，归一化到 [-1,1] 后交给库的 focusController，
   * 它自带插值平滑 —— 因此 Rust 侧 60ms 一次的轮询频率足够，不会显得一跳一跳。
   */
  /**
   * 直接指定视线方向（focusController 的归一化坐标，-1~1）。
   * 过渡由 Cubism 的 focusController 自己做（它带阻尼），这里只给目标。
   */
  lookToward(x: number, y: number): void {
    const internal = this.model?.internalModel as unknown as {
      focusController?: { focus(x: number, y: number, instant?: boolean): void };
    } | undefined;
    internal?.focusController?.focus(x, y);
  }
  lookAt(x: number, y: number): void {
    const width = this.host.clientWidth, height = this.host.clientHeight;
    if (!width || !height) return;
    this.lookToward((x / width) * 2 - 1, -((y / height) * 2 - 1));
  }
  /** 收回视线，看向正前方。 */
  lookAhead(): void { this.lookToward(0, 0); }
  /** 关闭跟随时把视线收回正前方，否则会僵在最后一次的位置。 */
  /** 全身 / 聚焦模式，由菜单切换。 */
  setFraming(framing: Framing): void {
    if (this.framing === framing) return;
    this.framing = framing;
    this.fit();
    this.log({ event: "framing", framing });
  }
  /**
   * 聚焦模式的放大基数（= 100 / 可见百分比）。
   * 模型身长比例差别很大，固定值对 2/3 身的模型会裁到只剩头，所以开放给设置窗口调。
   */
  setFocusZoom(zoom: number, explicit = false): void {
    if (this.focusZoomBase === zoom && this.focusZoomExplicit === explicit) return;
    this.focusZoomBase = zoom;
    this.focusZoomExplicit = explicit;
    if (this.framing === "focus") this.fit();
    this.log({ event: "framing:focus-zoom", zoom: Number(zoom.toFixed(2)) });
  }
  /**
   * 人物当前包围盒（CSS 像素），取自模型**声明的**画布。供 `hitArea` 兜底。
   *
   * 注意这个盒子比人物大得多 —— Live2D 作者普遍在四周留出透明边距给头发与衣摆的摆动，
   * 实测 CandyBoy 声明的画布占了窗口 91.7%，人物真正的像素只有 31.5%。真正的命中判定
   * 走 `hitArea`，这里只在抽不出像素时顶上。
   */
  bounds(): { x: number; y: number; width: number; height: number } | undefined {
    if (!this.model) return undefined;
    // 聚焦模式下模型远超窗口，命中区域必须裁到窗口内，否则穿透判定会把窗口外也算成人物。
    const box = this.model.getBounds();
    const left = Math.max(0, box.minX), top = Math.max(0, box.minY);
    const right = Math.min(this.host.clientWidth, box.maxX), bottom = Math.min(this.host.clientHeight, box.maxY);
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
  }
  /**
   * 人物的命中区域：不透明像素的外接矩形 + 盒内的占位网格。供 Rust 侧光标命中判定使用。
   *
   * 返回的是采样线程最近一次的结果（见 `startHitSampling`），还没采到时退回 `bounds()`
   * 的矩形 —— 命中松一点，总好过一只点不动的桌宠。
   */
  hitArea(): HitArea | undefined {
    return this.latestHitArea ?? this.bounds();
  }
  private hitCanvas?: HTMLCanvasElement;
  private hitContext?: CanvasRenderingContext2D | null;
  private latestHitArea?: HitArea;
  private lastHitSampleAt = 0;
  private stopHitSampling?: () => void;
  /**
   * 每隔 HIT_SAMPLE_MS 把画面缩到一张 ~62×80 的小图，读 alpha 通道算出命中网格。
   *
   * **必须挂在 ticker 上、且优先级低于渲染**（UTILITY < Application 用的 LOW），
   * 不能用 setInterval 也不能用 requestAnimationFrame：画布没开 `preserveDrawingBuffer`，
   * 绘制缓冲在合成之后就没了，帧外 drawImage 读到的是一张全透明的图
   * （实测覆盖率 0%，表现就是人物整只点不动）。
   *
   * 也**不能**用 `renderer.extract`：那条路会把 stage 重渲进一张小 RenderTexture，而
   * pixi-live2d-display 的 Cubism 渲染器按渲染目标尺寸算投影矩阵，尺寸一换就画出一块斜楔子
   * ——实测拿到的不是人物形状，命中区域会整个跑到窗口角上去。直接读已经画好的那一帧，
   * 既绕开这个耦合，也省掉多渲染一遍。
   */
  private startHitSampling(): void {
    const app = this.app;
    if (!app) return;
    const sample = () => {
      const now = performance.now();
      if (now - this.lastHitSampleAt < HIT_SAMPLE_MS) return;
      this.lastHitSampleAt = now;
      const width = this.host.clientWidth, height = this.host.clientHeight;
      const cols = Math.max(1, Math.round(width / HIT_CELL_PX)), rows = Math.max(1, Math.round(height / HIT_CELL_PX));
      if (!this.hitCanvas) {
        this.hitCanvas = document.createElement("canvas");
        // willReadFrequently：不加的话每次 getImageData 都会把纹理从 GPU 拉回来，实测慢一个量级
        this.hitContext = this.hitCanvas.getContext("2d", { willReadFrequently: true });
      }
      const context = this.hitContext;
      if (!context) return;
      if (this.hitCanvas.width !== cols || this.hitCanvas.height !== rows) {
        this.hitCanvas.width = cols; this.hitCanvas.height = rows;
      }
      try {
        context.clearRect(0, 0, cols, rows);
        context.drawImage(app.canvas, 0, 0, cols, rows);
        const { data } = context.getImageData(0, 0, cols, rows);
        this.latestHitArea = packHitMask(data, cols, rows, width, height);
      } catch (error) {
        this.warnOnce("hit-mask:sample-failed", { error: String(error).slice(0, 200) });
        this.latestHitArea = undefined;
      }
    };
    app.ticker.add(sample, null, UPDATE_PRIORITY.UTILITY);
    this.stopHitSampling = () => app.ticker.remove(sample);
  }
  /** 采样每几百毫秒跑一次，失败会刷屏；同一个原因只记一次。 */
  private warned = new Set<string>();
  private warnOnce(event: string, detail: object): void {
    if (this.warned.has(event)) return;
    this.warned.add(event);
    this.log({ event, ...detail });
  }
  /**
   * 常驻开关：每帧把这些参数按住。
   *
   * **必须每帧写，不能只写一次。** 在 boy8 上只写一次确实会一直生效，但那只是因为它恰好
   * 没有动作去碰这几个参数；换个模型完全可能有动作每帧重算同一个参数，那时候设一次
   * 下一帧就被盖掉，表现是「勾了偶尔失效」这种最难查的样子。
   *
   * 写的时机也讲究：必须在 `internalModel.update()` **之后** —— 动作、表情、物理都在那里面
   * 算完并写进参数，在它之前写等于白写。所以这里包住 update 而不是挂 ticker。
   */
  setHeldParameters(values: Record<string, number>): void {
    const internal = this.model?.internalModel as unknown as InternalModelWithUpdate | undefined;
    const released = Object.keys(this.held).filter(id => !(id in values));
    this.held = values;
    if (!internal) return;
    // **取消常驻必须显式写回默认值。** Cubism 的参数是逐帧保留的，只有被动作/表情/物理
    // 驱动的那些才会每帧重写；开关参数没人驱动，所以「不再写它」不等于「关掉它」——
    // 值会原样留在那里，表现是取消勾选之后猫耳还是不见（实测踩到过）。
    for (const id of released) {
      const core = internal.coreModel;
      const index = core.getParameterIndex(id);
      if (index >= 0) core.setParameterValueById(id, core.getParameterDefaultValue(index));
    }
    if (this.holdInstalled) return;
    const original = internal.update.bind(internal);
    internal.update = (deltaSeconds: number, now: number) => {
      original(deltaSeconds, now);
      const core = internal.coreModel;
      for (const [id, value] of Object.entries(this.held)) core.setParameterValueById(id, value);
    };
    this.holdInstalled = true;
  }
  private held: Record<string, number> = {};
  private holdInstalled = false;
  /** 整体不透明度。Pixi 的 alpha 不会传进 Cubism，须用官方 setModelColor（其内部按预乘处理）。 */
  setOpacity(value: number): void {
    const alpha = Math.max(0, Math.min(1, value));
    (this.model?.internalModel as unknown as { renderer?: { setModelColor(r: number, g: number, b: number, a: number): void } })
      ?.renderer?.setModelColor(1, 1, 1, alpha);
  }
  /** 菜单里手动播放一次；不改变语义状态。 */
  /**
   * 用户从菜单手点的动作，用 FORCE 优先级。
   *
   * 默认是 NORMAL，会被**正在播的** NORMAL 动作（语义态自动切的那些）挡掉并返回 false ——
   * 实机日志里 6 次点击有 5 次 `started:false`，表现就是「点了没反应」。
   * 用户显式点的动作不该输给自动动作；语义态那条路径（`playSemantic`）保持 NORMAL 不变，
   * 于是自动动作也不会反过来打断用户刚点的。
   */
  playMotion(group: string, index: number): void {
    void this.model?.motion(group, index, MotionPriority.FORCE)
      .then(started => this.log({ event: "menu:motion", group, index, started }))
      .catch(error => this.log({ event: "menu:motion:error", group, index, error: String(error) }));
  }
  /** 用户设置优先于模型 manifest；空映射恢复模型作者的默认配置。 */
  setSemanticMotions(value: Partial<Record<SemanticState, [string, number]>>): void {
    this.semanticMotions = { ...value };
    this.log({ event: "model:semantic-motions", states: Object.keys(value) });
  }
  /** 语义状态 → 表情，用户配的那一份。没配的状态仍然回落到模型清单。 */
  setSemanticExpressions(value: Partial<Record<SemanticState, string>>): void {
    this.semanticExpressions = { ...value };
    this.log({ event: "model:semantic-expressions", states: Object.keys(value) });
  }
  /**
   * 播放表情。Cubism 的表情是持久状态，设上不会自己回去，故默认在 `revertAfterMs` 后复位到中性脸。
   * 传 0 表示保持不变（语义状态用，见 `playSemantic`）。
   */
  playExpression(name: string, revertAfterMs = EXPRESSION_REVERT_MS): void {
    this.cancelExpressionRevert();
    // 记下**是否真的应用了**：原来只记「调用过」，于是表情没生效时日志和成功时长得一模一样，
    // 与动作那个 started:false 是同一类盲区。
    void Promise.resolve(this.model?.expression(name))
      .then(applied => this.log({ event: "menu:expression", name, revertAfterMs, applied }))
      .catch(error => this.log({ event: "menu:expression:error", name, error: String(error) }));
    if (revertAfterMs > 0) {
      this.expressionRevert = window.setTimeout(() => {
        this.expressionRevert = undefined;
        this.resetExpression();
      }, revertAfterMs);
    }
  }
  /** 回到中性脸（库在初始化时建的 defaultExpression）。 */
  resetExpression(): void {
    this.cancelExpressionRevert();
    // 表情管理器挂在 motionManager 下，不在 internalModel 根上。
    const manager = (this.model?.internalModel?.motionManager as unknown as {
      expressionManager?: { resetExpression(): void; currentExpression: unknown; defaultExpression: unknown };
    })?.expressionManager;
    if (!manager) return;
    manager.resetExpression();
    // 库的 resetExpression 只应用默认表情、不更新 currentExpression，而 setExpression 又会把
    // 「已是当前表情」的请求直接丢弃 —— 不同步这一步，复位后再选同一个表情会静默失效。
    manager.currentExpression = manager.defaultExpression;
    this.log({ event: "expression:reset" });
  }
  private cancelExpressionRevert(): void {
    if (this.expressionRevert === undefined) return;
    clearTimeout(this.expressionRevert);
    this.expressionRevert = undefined;
  }
  get modelFile(): string | undefined { return this.manifest?.model; }

  /**
   * 模型用了几个 offscreen（Cubism 5.1 起的离屏合成）。
   *
   * 大于 0 就画不对：pixi-live2d-display 打包的是 Cubism 4 Framework，没有离屏概念，
   * 那些本该先画进离屏缓冲、再按缓冲自己的顺序合成回去的部件会被拍平成一层，
   * 结果是被后画的部件盖住（ren 的眉毛/鼻子/嘴就是这么消失的）。
   * 官方 Framework 5 的 `drawObjectLoop` 才有这套，但它的授权不允许我们随源码公开分发。
   */
  get offscreenCount(): number {
    const core = (this.model?.internalModel?.coreModel as
      { getModel?: () => { offscreens?: { count?: number } } } | undefined)?.getModel?.();
    return core?.offscreens?.count ?? 0;
  }
  reset(): void { this.setVocalLevel(0); }
  destroy(): void { this.cancelExpressionRevert(); this.stopHitSampling?.(); this.stopHitSampling = undefined; this.stopResizeWatch?.(); this.stopResizeWatch = undefined; this.removeContextListeners?.(); this.removeContextListeners = undefined; this.model?.destroy(); this.app?.destroy(true); }
}
