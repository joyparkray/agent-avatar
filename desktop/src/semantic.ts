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
  /** 「它具体在干嘛」的一行（工具的 description / 文件名 / 域名 / 搜索词 / 命令）。空 = 没有。 */
  doing?: string | null;
  /** 详情的过期时刻（epoch 秒）。过了就不显示 —— 见下面 `liveDoing`。 */
  doing_until?: number | null;
  reaction?: { kind?: string; sequence?: number; at?: number } | null;
}

/** 连续几次读不到状态才回落 idle —— 单次抖动不该让形象掉表情。 */
const MISSES_BEFORE_IDLE = 3;

/**
 * 一条详情至少占屏多久。与连接器那边的 `DOING_HOLD_SECONDS` 是**两件事**：
 * 那个管「工具结束后别立刻消失」，这个管「相邻两条别互相顶」。
 */
const DOING_FLOOR_MS = 1000;

/**
 * 还在有效期内的详情，过期了就是空。
 *
 * 🔴 **详情比状态活得久，这是它能被看见的前提。** 工具跑完状态立刻回 idle，而快照是
 * 「当前值」、这边 200 ms 采一次 —— 短工具的窗口根本采不到。2026-09-04 实机量过
 * （5 ms 高频采样，Hermes）：带详情的状态只停留 62 / 91 / 184 ms，用户看到的是
 * 「一闪而过一次」。所以写入侧让详情多挂 1 秒并带上明写的过期时刻，这边照它判断。
 *
 * 没有 `doing_until` 的是老连接器写的快照 —— 那时候没有这个字段，照旧显示，
 * 不能因为升级了皮肤就把老连接器的详情全吞掉。
 */
export function liveDoing(snapshot: StateSnapshot, now = Date.now()): string {
  const doing = typeof snapshot.doing === "string" ? snapshot.doing : "";
  if (!doing) return "";
  const until = snapshot.doing_until;
  if (typeof until !== "number" || !Number.isFinite(until)) return doing;
  return now / 1000 <= until ? doing : "";
}

export class SemanticDriver {
  private timer?: number; private lastState?: SemanticState; private lastReactionKey?: string; private lastDoing = ""; private idleRounds = 0; private misses = 0;
  /** 当前这条详情是什么时候摆上去的 —— 最短占屏时间从这里算。 */
  private doingShownAt = 0;
  /** 还没轮到的下一条详情（只留最后一条，见 `emitDoingChanged`）。 */
  private pendingDoing?: string; private pendingTimer?: ReturnType<typeof setTimeout>;
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
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.timer = undefined; this.pendingTimer = undefined; this.pendingDoing = undefined;
  }
  private emitChanged(state: SemanticState): void { if (state !== this.lastState) { this.lastState = state; this.emit(state); } }
  /**
   * 详情跟着值变，不跟着 sequence —— 同一个工具连着报两次不该让状态栏闪。
   *
   * 🔴 **每条至少占屏 `DOING_FLOOR_MS`。** 连接器那边的 1 秒保底管的是「工具结束后详情
   * 别立刻消失」，管不了**相邻两条互相顶**：连着调两个工具时，第一条刚摆上去就被第二条
   * 顶掉，一样看不清（2026-09-04 用户实测原话：「第一个详情一闪而过被第二个顶掉了」）。
   *
   * 所以没到时间就把新的一条压住，到点再换。**只留最后一条**：连着来五个工具时显示
   * 第一个和最后一个，而不是排一条越拖越长的队 —— 状态栏落后现实好几秒比少显示两条更糟。
   */
  private emitDoingChanged(doing: string, now = Date.now()): void {
    if (doing === this.lastDoing && this.pendingDoing === undefined) return;
    const waited = now - this.doingShownAt;
    if (waited >= DOING_FLOOR_MS) {
      if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = undefined; }
      this.pendingDoing = undefined;
      if (doing === this.lastDoing) return;
      this.lastDoing = doing; this.doingShownAt = now; this.emitDoing(doing);
      return;
    }
    // 还没到时间：记下最后一条，到点一次性换过去
    this.pendingDoing = doing;
    if (this.pendingTimer) return;
    // 用全局 setTimeout 而不是 window.setTimeout：这段要能在 node 测试环境里跑
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      const next = this.pendingDoing;
      this.pendingDoing = undefined;
      if (next !== undefined && next !== this.lastDoing) {
        this.lastDoing = next; this.doingShownAt = Date.now(); this.emitDoing(next);
      }
    }, DOING_FLOOR_MS - waited);
  }
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
      this.emitDoingChanged(liveDoing(snapshot));
      this.emitSnapshotReaction(snapshot.reaction);
    } catch { this.miss(); }
  }
}
