/**
 * 闲置自治：没人说话、Hermes 也没在忙的时候，让 Echo 自己动起来。
 *
 * **不做位移**：模型没有走路动画，平移会变成脚不动的滑行，比站着不动更怪。
 * 自治由两件事组成 —— 播一个模型自带的动作，或者把视线挪向别处（"四处看看"）。
 * 视线的平滑过渡由 Cubism 的 focusController 自己做（它带阻尼），这里只负责挑目标。
 *
 * 调度逻辑与渲染分离（同 dock.ts 的做法）：这里全是纯函数，可以直接单测，
 * 不必把 pixi 与 Live2D 库拉进 node 环境。
 */

/** 忙完之后要静置多久才开始自治。太短会在两句话之间抢戏。 */
export const IDLE_GRACE_MS = 8_000;
/** 两次自治之间的间隔范围。随机化是为了不显得像节拍器。 */
export const IDLE_MIN_MS = 9_000;
export const IDLE_MAX_MS = 26_000;
/** 视线最多偏离正前方多少（focusController 的归一化坐标，1 = 满偏）。 */
export const GAZE_RANGE = 0.75;
/** 相邻两次视线目标至少要差这么多，否则看不出"看向了别处"。 */
export const GAZE_MIN_TRAVEL = 0.35;

export type IdleAction = "motion" | "expression" | "gaze";

/**
 * 把随机源钳到 [0, 1)。
 *
 * 注入的 random 返回 NaN 时后果不是"值不对"而是**失控**：NaN 的延时传给 setTimeout 会被
 * 当成 0，自治就变成每帧触发的疯狂循环；NaN 参与比较又永远是 false，会绕过所有的"别原地不动"
 * 判断。所以在入口一次性挡掉。
 */
function unitRoll(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.min(0.999, Math.max(0, value)) : 0.5;
}

/** 下一次自治的等待时长。 */
export function nextIdleDelay(random: () => number = Math.random, min = IDLE_MIN_MS, max = IDLE_MAX_MS): number {
  return Math.round(min + (max - min) * unitRoll(random));
}

/**
 * 这一次做什么：挪视线 / 播动作 / 换表情。
 *
 * 视线 70% / 动作 20% / 表情 10%。动作和表情都是有明确起止的表演，太频繁会显得多动 ——
 * 表情尤其，它是持久状态（会停在脸上直到复位），换得勤会让人觉得她在做鬼脸。
 * 而"看看这边、看看那边"正是没事做时最自然的样子。
 */
export function nextIdleAction(random: () => number = Math.random): IdleAction {
  const roll = unitRoll(random);
  if (roll < 0.7) return "gaze";
  return roll < 0.9 ? "motion" : "expression";
}

export interface Gaze { x: number; y: number }

/**
 * 挑一个新的视线目标（focusController 的归一化坐标，-1~1）。
 *
 * 会避开"跟现在几乎一样"的点：随机到那儿就等于该动的时候没动，看起来像卡住了。
 * 纵向范围压到横向的一半 —— 人物抬头低头的幅度本来就比左右小，满偏会翻白眼。
 */
export function nextGazeTarget(
  current: Gaze, random: () => number = Math.random, range = GAZE_RANGE,
): Gaze {
  const pick = (): Gaze => ({
    x: (unitRoll(random) * 2 - 1) * range,
    y: (unitRoll(random) * 2 - 1) * range * 0.5,
  });
  let target = pick();
  // 最多重挑几次；再挑不到就朝反方向推，绝不返回原地
  for (let attempt = 0; attempt < 3 && distance(target, current) < GAZE_MIN_TRAVEL; attempt++) {
    target = pick();
  }
  if (distance(target, current) < GAZE_MIN_TRAVEL) {
    return { x: clamp(-current.x || range, range), y: clamp(-current.y, range * 0.5) };
  }
  return target;
}

export function distance(a: Gaze, b: Gaze): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, range: number): number {
  return Math.min(range, Math.max(-range, value));
}

/**
 * 自治调度器。
 *
 * 只管"什么时候做点什么"，具体怎么表现交给回调 —— 这样它不依赖 pixi/Live2D，可以单测。
 * 说话或 Hermes 在忙时由外部调 `notifyBusy()` 推迟：自治是"没事做才做的事"，
 * 抢在正事前面就成了干扰。
 */
export class IdleAutonomy {
  private timer?: number;
  private gaze: Gaze = { x: 0, y: 0 };
  private running = false;

  constructor(
    private readonly act: (action: IdleAction, gaze: Gaze) => void,
    private readonly options: { graceMs?: number; minMs?: number; maxMs?: number } = {},
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    this.running = true;
    this.schedule(this.options.graceMs ?? IDLE_GRACE_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
  }

  /** 正在说话 / Hermes 在忙：把下一次自治推到静置期之后。 */
  notifyBusy(): void {
    if (!this.running) return;
    this.schedule(this.options.graceMs ?? IDLE_GRACE_MS);
  }

  /** 视线被别的来源（如跟随鼠标）改过，自治要接着从那儿算，不然下一次会跳回旧位置。 */
  syncGaze(gaze: Gaze): void { this.gaze = gaze; }

  /** 运行时改静置时长（毫秒）。改完按新值重新计时，不必等当前这一轮走完。 */
  setGrace(ms: number): void {
    this.options.graceMs = ms;
    if (this.running) this.schedule(ms);
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.fire(), delay);
  }

  private fire(): void {
    if (!this.running) return;
    const action = nextIdleAction(this.random);
    if (action === "gaze") this.gaze = nextGazeTarget(this.gaze, this.random);
    this.act(action, this.gaze);
    this.schedule(nextIdleDelay(this.random, this.options.minMs, this.options.maxMs));
  }
}
