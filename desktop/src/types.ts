export const SEMANTIC_STATES = ["idle", "reviewing", "writing", "researching", "executing", "syncing", "awaiting", "error"] as const;
export type SemanticState = typeof SEMANTIC_STATES[number];

/** 回落链的终点：manifest 必须**直接**为这六个态配动作，不能靠回落蒙混过去。 */
export const REQUIRED_MOTION_STATES = ["idle", "writing", "researching", "executing", "syncing", "error"] as const;

/**
 * 基态缺少自己的动作/表情时回落到哪个基态。
 *
 * `syncing` 拆成三态（awaiting/reviewing/syncing）后，皮肤**没有义务**为每个新态单独配一套 ——
 * 共用是允许的。回落链让既有 manifest 一行不改就继续可用，第三方模型也不会因为我们加基态而失效；
 * 想单独配时在 manifest 里写一条即可覆盖。
 *
 * 只给**新增态**配回落：老的六个态仍是必填，否则「某个状态从不播放」这类回归就没人挡了
 * （Haru 曾把两个状态指到不存在的动作序号）。于是校验统一走 resolveForState 即可 ——
 * 老态没有回落项，解析等价于直接查表。
 */
export const STATE_FALLBACK: Partial<Record<SemanticState, SemanticState>> = {
  awaiting: "syncing", reviewing: "syncing",
};

/** 顺着回落链取 manifest 里为该基态配置的资源（动作/表情）。 */
export function resolveForState<T>(map: Partial<Record<SemanticState, T>> | undefined, state: SemanticState): T | undefined {
  let current: SemanticState | undefined = state;
  for (let hops = 0; current && hops <= SEMANTIC_STATES.length; hops++) {
    const value = map?.[current];
    if (value !== undefined) return value;
    current = STATE_FALLBACK[current];
  }
  return undefined;
}

/** 用户映射只覆盖明确选过的状态；其余继续使用模型 manifest 的回落链。 */
export function resolveSemanticMotion(
  overrides: Partial<Record<SemanticState, [string, number]>>, defaults: Partial<Record<SemanticState, [string, number]>>, state: SemanticState,
): [string, number] | undefined {
  return overrides[state] ?? resolveForState(defaults, state);
}
export const REACTIONS = ["blocked", "interrupted"] as const;
export type Reaction = typeof REACTIONS[number];
export type EmotionCue = "relaxed" | "focused" | "curious" | "active" | "connected" | "concerned";
export interface AvatarState { semantic: SemanticState; speaking: boolean; reaction: Reaction | null; emotion: EmotionCue | null }
/**
 * 一个可加载的形象。
 *
 * `manifest`（avatar.json）是**可选**的精细适配：官方 `model3.json` 已经声明了口型参数
 * （`Groups[LipSync]`，库自动读）、眨眼参数、动作组与表情清单，我们不需要用户重抄一遍。
 * avatar.json 只提供官方给不了的那一样 —— 「哪个语义态播哪个动作/表情」。
 * 没有它时给出 `model3` 文件名即可，所有语义态回落到 Idle 组。
 */
export interface AvatarSource { baseUrl: string; manifest?: string; model3?: string }
export interface AvatarModel {
  load(source: AvatarSource): Promise<void>;
  setVocalLevel(level: number): void;
  /** `applyExpression=false` keeps the mouth neutral while still changing the body motion. */
  playSemantic(state: SemanticState, applyExpression?: boolean): void;
  playReaction(reaction: Reaction, durationMs: number): void;
  applyEmotion(cue: EmotionCue | null): void;
  reset(): void;
  resetExpression(): void;
  destroy(): void;
}
export interface AvatarDriver {
  onVocalLevel(cb: (level: number) => void): () => void;
  onSpeaking(cb: (speaking: boolean) => void): () => void;
  reset(): void;
}
export interface AvatarDirector {
  setSemantic(state: SemanticState): void;
  setTalking(on: boolean): void;
  setReaction(reaction: Reaction): void;
  setEmotion(cue: EmotionCue | null): void;
  stop(): void;
}
export interface AvatarManifest {
  id: string; version: string; cubismVersion: 4; model: string;
  expressions?: Partial<Record<Exclude<SemanticState, "idle">, string>>;
  reactions?: Partial<Record<Reaction, string>>;
  /** `REQUIRED_MOTION_STATES` 必填；新增态缺省时按 `STATE_FALLBACK` 共用。 */
  motions: Partial<Record<SemanticState, [string, number]>> & Record<typeof REQUIRED_MOTION_STATES[number], [string, number]>;
}
