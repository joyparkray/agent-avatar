import { ClipLevelTimeline, int16ToFloat32, MonotonicScheduler } from "./audio";
import { GlobalLevelTracker } from "./audio-source";
import type { AvatarDriver } from "./types";
type AudioContextLike = AudioContext;
export type FallbackEvent = { data_url?: string; mime_type?: string };
export type VoiceLog = (event: object) => void;
export function decodeAudioDataUrl(dataUrl: string): ArrayBuffer {
  const comma = dataUrl.indexOf(","); if (comma < 0 || !/^data:audio\//i.test(dataUrl)) throw new Error("invalid audio data URL");
  const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), c => c.charCodeAt(0)); return bytes.buffer;
}
export function voiceWebSocketUrl(endpoint: string, token = "", path = "/api/audio/observe"): string { return endpoint.replace(/^http/, "ws") + `${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`; }
export class VoiceDriver implements AvatarDriver {
  private levels = new Set<(n: number) => void>(); private speaking = new Set<(v: boolean) => void>(); private ws?: WebSocket;
  private context?: AudioContextLike; private analyser?: AnalyserNode; private scheduler = new MonotonicScheduler(); private sources = new Set<AudioBufferSourceNode>(); private resetTimer?: number; private lastVocalLogAt = -Infinity;
  /**
   * 电平走「切帧 → 按播放时钟出队 → 通用包络」这条链，与文件/全局音源同一套 `GlobalLevelTracker`：
   * 自适应峰值把不同 TTS provider 的音量差异吃掉，用户换 provider 不需要重调参数。
   */
  private timeline = new ClipLevelTimeline(); private tracker = new GlobalLevelTracker(); private pump?: number;
  constructor(private readonly log?: VoiceLog) {}
  onVocalLevel(cb: (level: number) => void): () => void { this.levels.add(cb); return () => this.levels.delete(cb); }
  onSpeaking(cb: (speaking: boolean) => void): () => void { this.speaking.add(cb); return () => this.speaking.delete(cb); }
  connect(endpoint: string, token = "", path = "/api/audio/observe"): void {
    this.reset(); const url = voiceWebSocketUrl(endpoint, token, path);
    this.ws = new WebSocket(url); this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = event => void this.message(event.data);
    this.ws.onclose = () => { this.log?.({ event: "voice:closed" }); this.resetWithin150ms(); }; this.ws.onerror = () => { this.log?.({ event: "voice:error" }); this.resetWithin150ms(); };
  }
  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
  sendText(text: string): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ text })); }
  finish(): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ done: true })); }
  stopRemote(): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ stop: true })); this.reset(); }
  private async message(data: unknown): Promise<void> {
    if (data instanceof ArrayBuffer) return this.schedulePcm(data);
    const event = JSON.parse(String(data)) as { type: string; sample_rate?: number; data_url?: string; mime_type?: string };
    if (event.type === "start") { this.ensureAudio(event.sample_rate ?? 24000); this.speaking.forEach(cb => cb(true)); }
    if (event.type === "end") this.resetWithin150ms();
    if (event.type === "fallback") await this.fallback(event);
  }
  private ensureAudio(rate: number): void { if (!this.context) { this.context = new AudioContext({ sampleRate: rate }); this.analyser = this.context.createAnalyser(); } }
  private schedulePcm(data: ArrayBuffer): void {
    this.ensureAudio(24000); const samples = int16ToFloat32(data); const buffer = this.context!.createBuffer(1, samples.length, this.context!.sampleRate); buffer.copyToChannel(samples, 0);
    const source = this.context!.createBufferSource(); source.buffer = buffer; source.connect(this.analyser!); // Intentionally no destination: P0 is silent.
    const start = this.scheduler.schedule(this.context!.currentTime, buffer.duration); source.start(start); this.sources.add(source); source.onended = () => this.sources.delete(source);
    this.timeline.push(samples, this.context!.sampleRate, start); this.startPump();
  }
  /** 按播放时钟把帧电平放出去。整段 fallback 与流式帧在这里被统一成同一种「随时间起伏」。 */
  private startPump(): void {
    if (this.pump !== undefined) return;
    const tick = () => {
      const context = this.context;
      if (!context) { this.pump = undefined; return; }
      const raw = this.timeline.advance(context.currentTime);
      // 队列空时继续喂 0，让包络自然释放，而不是一刀切到闭嘴
      const { level } = this.tracker.update(raw ?? 0, context.currentTime * 1000);
      this.levels.forEach(cb => cb(level));
      const now = performance.now();
      if (now - this.lastVocalLogAt >= 500) { this.lastVocalLogAt = now; this.log?.({ event: "vocal-level", level: Number(level.toFixed(3)), pending: this.timeline.pending }); }
      if (!this.timeline.pending && level <= 0) { this.pump = undefined; return; }
      this.pump = requestAnimationFrame(tick);
    };
    this.pump = requestAnimationFrame(tick);
  }
  private async fallback(event: FallbackEvent): Promise<void> {
    if (!event.data_url) return this.resetWithin150ms();
    try { this.ensureAudio(24000); const decoded = await this.context!.decodeAudioData(decodeAudioDataUrl(event.data_url)); const channel = decoded.getChannelData(0); const pcm = new Int16Array(channel.length); channel.forEach((v, i) => pcm[i] = Math.max(-1, Math.min(1, v)) * 32767); this.speaking.forEach(cb => cb(true)); this.schedulePcm(pcm.buffer); this.resetTimer = window.setTimeout(() => this.resetAnalysis(), decoded.duration * 1000 + 100); } catch { this.resetWithin150ms(); }
  }
  resetWithin150ms(): void { if (this.resetTimer) clearTimeout(this.resetTimer); this.resetTimer = window.setTimeout(() => this.resetAnalysis(), 100); }
  private resetAnalysis(): void { if (this.resetTimer) clearTimeout(this.resetTimer); if (this.pump !== undefined) { cancelAnimationFrame(this.pump); this.pump = undefined; } this.sources.forEach(source => { try { source.stop(); } catch {} }); this.sources.clear(); this.scheduler.reset(); this.timeline.reset(); this.tracker.reset(); this.levels.forEach(cb => cb(0)); this.speaking.forEach(cb => cb(false)); const event = { event: "voice-reset", level: 0, at: performance.now() }; console.info(JSON.stringify(event)); this.log?.(event); }
  reset(): void { this.ws?.close(); this.ws = undefined; this.resetAnalysis(); }
}
