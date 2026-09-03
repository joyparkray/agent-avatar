import { REACTIONS, SEMANTIC_STATES, type EmotionCue, type Reaction, type SemanticState } from "./types";

export function mapHookState(value?: string): SemanticState {
  return (SEMANTIC_STATES as readonly string[]).includes(value ?? "") ? value as SemanticState : "idle";
}

// 情绪是**投影**，允许多态共用：awaiting 与 syncing 都是「连着别的东西」，reviewing 是安静地整理。
const EMOTIONS: Record<SemanticState, EmotionCue> = {
  idle: "relaxed", reviewing: "focused", writing: "focused", researching: "curious",
  executing: "active", syncing: "connected", awaiting: "connected", error: "concerned",
};
export function emotionForSemantic(state: SemanticState): EmotionCue { return EMOTIONS[state]; }

export interface StateSnapshot {
  state?: string; sequence?: number;
  /** 「它具体在干嘛」的一行（工具的 description / 文件名 / 域名 / 搜索词）。空 = 没有。 */
  doing?: string | null;
  reaction?: { kind?: string; sequence?: number; at?: number } | null;
}

/** 连续几次读不到状态才回落 idle —— 单次抖动不该让形象掉表情。 */
const MISSES_BEFORE_IDLE = 3;

export class SemanticDriver {
  private timer?: number; private lastState?: SemanticState; private lastReactionKey?: string; private lastDoing = ""; private idleRounds = 0; private misses = 0;
  constructor(
    private readonly read: () => Promise<StateSnapshot | null>,
    private readonly emit: (state: SemanticState) => void,
    private readonly intervalMs = 200,
    private readonly maxIntervalMs = 2000,
    private readonly emitReaction: (reaction: Reaction) => void = () => {},
    private readonly emitDoing: (doing: string) => void = () => {},
  ) {}
  start(): void { void this.tick(); this.schedule(this.intervalMs); }
  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.tick().finally(() => this.schedule(this.nextDelay())); }, delay);
  }
  private nextDelay(): number { return Math.min(this.maxIntervalMs, this.intervalMs * 2 ** Math.min(this.idleRounds, 4)); }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private emitChanged(state: SemanticState): void { if (state !== this.lastState) { this.lastState = state; this.emit(state); } }
  /** 详情跟着值变，不跟着 sequence —— 同一个工具连着报两次不该让状态栏闪。 */
  private emitDoingChanged(doing: string): void { if (doing !== this.lastDoing) { this.lastDoing = doing; this.emitDoing(doing); } }
  /**
   * 去重键是 hook 的单调时间戳 `at`，不是 `sequence`。
   *
   * sequence 存在易失的 `.sessions` 文件里，文件重建（schema 变更 / TMPDIR 被清）后从 1 重新开始，
   * 拿它当门会把下一条反应当成「已见过」整条吞掉 —— 与当年基态那个 sequence 门是同一个坑。
   * 老快照没有 `at` 时它是 0，退化成「每种反应触发一次」，而不是整条丢掉。
   */
  private emitSnapshotReaction(value: StateSnapshot["reaction"]): void {
    if (!value || !(REACTIONS as readonly string[]).includes(value.kind ?? "")) return;
    const at = Number(value.at);
    if (!Number.isFinite(at) || at < 0) return;
    const key = `${value.kind}@${at}`;
    if (key === this.lastReactionKey) return;
    this.lastReactionKey = key;
    this.emitReaction(value.kind as Reaction);
  }
  /** 读不到状态：连续 MISSES_BEFORE_IDLE 次才回落，避免一次抖动就掉表情。 */
  private miss(): void {
    this.idleRounds++;
    if (++this.misses >= MISSES_BEFORE_IDLE) { this.emitChanged("idle"); this.emitDoingChanged(""); }
  }
  private async tick(): Promise<void> {
    try {
      const snapshot = await this.read();
      if (!snapshot) return this.miss();
      this.idleRounds = 0; this.misses = 0;
      this.emitChanged(mapHookState(snapshot.state));
      this.emitDoingChanged(typeof snapshot.doing === "string" ? snapshot.doing : "");
      this.emitSnapshotReaction(snapshot.reaction);
    } catch { this.miss(); }
  }
}
