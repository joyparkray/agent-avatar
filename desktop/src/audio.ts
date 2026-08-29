export function int16ToFloat32(input: ArrayBuffer): Float32Array<ArrayBuffer> {
  const source = new Int16Array(input); const output = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) output[i] = Math.max(-1, source[i] / 32768);
  return output;
}
export function rms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0; let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
/**
 * 把任意长度的 PCM 拆成定长帧的 RMS，挂在**播放时钟**的绝对时刻上排队。
 *
 * 存在的理由：Hermes 的音频有两种形态，取决于用户配的 TTS provider——
 * 流式 provider（elevenlabs/openai/gemini/xai）给一串小 PCM 帧，
 * 非流式的（edge 等）走 fallback 一次性给整段。整段只算一个 RMS 的话，
 * 嘴会以一个恒定开度张着直到播完，完全不跟音节。
 * 切帧后两种形态都变成「按时间推进的电平序列」，与 provider 无关。
 *
 * 时刻用 AudioContext 时钟而不是自起定时器 —— 这是架构里的硬约束：
 * 嘴型跟音频帧，且必须复用播放时钟，否则长句会漂。
 */
export class ClipLevelTimeline {
  private frames: { at: number; raw: number }[] = [];
  constructor(readonly frameSeconds = 0.05) {}
  push(samples: ArrayLike<number>, sampleRate: number, startAt: number): void {
    const size = Math.max(1, Math.round(sampleRate * this.frameSeconds));
    for (let offset = 0; offset < samples.length; offset += size) {
      const end = Math.min(samples.length, offset + size);
      let sum = 0;
      for (let i = offset; i < end; i++) sum += samples[i] ** 2;
      this.frames.push({ at: startAt + offset / sampleRate, raw: Math.sqrt(sum / (end - offset)) });
    }
  }
  /** 推进到 `now`（AudioContext 秒）。返回该发的原始电平；没有到期帧则 undefined。 */
  advance(now: number): number | undefined {
    let value: number | undefined;
    while (this.frames.length && this.frames[0].at <= now) value = this.frames.shift()!.raw;
    return value;
  }
  get pending(): boolean { return this.frames.length > 0; }
  reset(): void { this.frames = []; }
}
export class MonotonicScheduler {
  nextStartAt = 0;
  constructor(readonly jitterSeconds = 0.075) {}
  schedule(now: number, duration: number): number { const start = Math.max(this.nextStartAt, now + this.jitterSeconds); this.nextStartAt = start + duration; return start; }
  reset(): void { this.nextStartAt = 0; }
}
