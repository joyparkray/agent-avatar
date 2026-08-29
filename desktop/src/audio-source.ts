import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VoiceDriver } from "./voice";

export type AudioSource = "off" | "hermes" | "file" | "global";

/**
 * 人声频段（电话带宽），与原生侧全局捕获保持同一口径。
 * 混音里鼓与贝斯能量最大、最容易把嘴顶开，而它们基本在 300 Hz 以下；3400 Hz 以上多为镲片与齿音。
 * 这能明显削掉非人声的驱动，但**不是人声分离** —— 同频段的乐器仍会驱动嘴型。
 */
export const VOICE_BAND_HZ = { low: 300, high: 3400 } as const;
export type HermesEndpoint = { url: string; token?: string; path: string } | null;

/**
 * 跟着音乐哼唱的口型包络。
 *
 * 时间常数而非「每次回调乘固定比例」—— 全局音源的原生回调约 10ms 一次、文件音源走 rAF 约 16ms 一次，
 * 用固定比例会让同一套参数在两个音源下手感不同。
 *
 * 攻击快到能跟上音节，释放明显慢于攻击：混音里分不出人声（实测带通、中置提取、共振峰占比三种方法
 * 在真实歌曲上都无法区分器乐与人声），所以目标不是「只在唱歌时张嘴」，而是让嘴跟着旋律起伏，
 * 读起来像哼唱而不是对每个鼓点抽动。
 */
const ATTACK_MS = 45;
const RELEASE_MS = 240;
/** 峰值回落的半衰期，用来适应系统音量变化。 */
const PEAK_HALF_LIFE_MS = 900;
const NOISE_FLOOR = 0.008;
const OPEN_AT = 0.06;
const CLOSE_AT = 0.02;

export class GlobalLevelTracker {
  private envelope = 0;
  private peak = 0.04;
  private active = false;
  private last?: number;

  update(raw: number, now: number = performance.now()): { level: number; speaking: boolean } {
    // 首帧与异常间隔都按一帧处理，避免长时间静默后跳变
    const elapsed = this.last === undefined ? 16 : Math.min(200, Math.max(1, now - this.last));
    this.last = now;
    const input = Math.max(0, Math.min(1, raw));
    this.peak = Math.max(0.04, input, this.peak * Math.pow(0.5, elapsed / PEAK_HALF_LIFE_MS));
    const normalized = input < NOISE_FLOOR ? 0 : Math.min(1, (input - NOISE_FLOOR) / Math.max(0.01, this.peak - NOISE_FLOOR));
    // 幂曲线保留音节差异，同时抬起较轻的辅音
    const target = Math.pow(normalized, 0.7);
    const constant = target > this.envelope ? ATTACK_MS : RELEASE_MS;
    this.envelope += (target - this.envelope) * (1 - Math.exp(-elapsed / constant));
    if (!this.active && this.envelope >= OPEN_AT) this.active = true;
    else if (this.active && this.envelope <= CLOSE_AT) this.active = false;
    return { level: this.active ? this.envelope : 0, speaking: this.active };
  }

  reset(): { level: 0; speaking: false } {
    this.envelope = 0; this.peak = 0.04; this.active = false; this.last = undefined;
    return { level: 0, speaking: false };
  }
}

export class AudioSourceController {
  private source: AudioSource = "hermes";
  private unlisten: UnlistenFn[] = [];
  private readonly globalLevel = new GlobalLevelTracker();
  private fileAudio?: HTMLAudioElement;
  private fileContext?: AudioContext;
  private fileFrame?: number;
  private fileUrl?: string;

  constructor(
    private readonly voice: VoiceDriver,
    private endpoint: HermesEndpoint,
    private readonly invoke: (command: string) => Promise<unknown>,
    private readonly vocal: (level: number) => void,
    private readonly speaking: (value: boolean) => void,
    private readonly log?: (event: object) => void,
  ) {}

  get current(): AudioSource { return this.source; }

  private lastSpeaking = false;
  /**
   * 只在开/合翻转时记一条 —— 定时记录会让日志每秒写盘两次、永不停歇。
   * 保留这条的意义是：「嘴不动」时能区分「没有电平」与「电平到了但没生效」。
   */
  private report(level: number, speaking: boolean): void {
    this.vocal(level);
    this.speaking(speaking);
    if (speaking === this.lastSpeaking) return;
    this.lastSpeaking = speaking;
    this.log?.({ event: "audio-level", source: this.source, level: Number(level.toFixed(3)), speaking });
  }

  /**
   * 换用新的 Hermes 端点/凭据并（在 Hermes 源下）重连。
   *
   * token 不是启动时就有的：desktop 每次启动重新随机生成，由 hook 写进状态文件后皮肤才读到；
   * desktop 重启还会换端口。所以端点得能在运行中更新，否则用户必须重启皮肤。
   */
  async retarget(endpoint: HermesEndpoint): Promise<void> {
    const unchanged = this.endpoint?.url === endpoint?.url && this.endpoint?.token === endpoint?.token;
    this.endpoint = endpoint;
    if (unchanged || this.source !== "hermes") return;
    this.log?.({ event: "audio-source:retarget", url: endpoint?.url ?? null, hasToken: Boolean(endpoint?.token) });
    await this.start("hermes");
  }

  async start(source: AudioSource): Promise<void> {
    await this.stop();
    this.source = source;
    if (source === "off") { this.log?.({ event: "audio-source", source }); return; }
    if (source === "hermes") {
      if (this.endpoint) this.voice.connect(this.endpoint.url, this.endpoint.token ?? "", this.endpoint.path);
      this.log?.({ event: "audio-source", source });
      return;
    }
    if (source === "file") return;
    this.unlisten.push(await listen<number>("global-audio-level", event => {
      const frame = this.globalLevel.update(Number(event.payload) || 0);
      this.report(frame.level, frame.speaking);
    }));
    this.unlisten.push(await listen<string>("global-audio-error", event => {
      this.globalLevel.reset(); this.vocal(0); this.speaking(false);
      this.log?.({ event: "global-audio:error", reason: String(event.payload) });
    }));
    try {
      await this.invoke("start_global_audio");
      this.log?.({ event: "audio-source", source });
    } catch (error) {
      this.unlisten.forEach(remove => remove()); this.unlisten = [];
      this.vocal(0); this.speaking(false);
      throw error;
    }
  }

  async playFile(file: File): Promise<void> {
    await this.start("file");
    this.log?.({ event: "audio-file:loading", name: file.name, size: file.size, type: file.type });
    const audio = new Audio(), context = new AudioContext(), analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const source = context.createMediaElementSource(audio);
    // 播放走原声；带通只挂在分析这一路，否则听到的音乐会被滤成电话音质
    source.connect(context.destination);
    const highpass = context.createBiquadFilter(), lowpass = context.createBiquadFilter();
    highpass.type = "highpass"; highpass.frequency.value = VOICE_BAND_HZ.low;
    lowpass.type = "lowpass"; lowpass.frequency.value = VOICE_BAND_HZ.high;
    source.connect(highpass).connect(lowpass).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    this.fileAudio = audio; this.fileContext = context;
    this.fileUrl = URL.createObjectURL(file); audio.src = this.fileUrl;
    const update = () => {
      analyser.getFloatTimeDomainData(samples);
      let squares = 0;
      for (const sample of samples) squares += sample * sample;
      const frame = this.globalLevel.update(Math.sqrt(squares / samples.length));
      this.report(frame.level, frame.speaking);
      if (!audio.paused && !audio.ended) this.fileFrame = requestAnimationFrame(update);
    };
    audio.addEventListener("play", update, { once: true });
    audio.addEventListener("ended", () => { const frame = this.globalLevel.reset(); this.vocal(frame.level); this.speaking(frame.speaking); }, { once: true });
    await context.resume(); await audio.play();
    this.log?.({ event: "audio-source", source: "file", name: file.name });
  }

  async stop(): Promise<void> {
    this.voice.reset();
    this.globalLevel.reset();
    this.unlisten.forEach(remove => remove()); this.unlisten = [];
    if (this.fileFrame !== undefined) cancelAnimationFrame(this.fileFrame);
    this.fileFrame = undefined; this.fileAudio?.pause(); this.fileAudio = undefined;
    await this.fileContext?.close().catch(() => {}); this.fileContext = undefined;
    if (this.fileUrl) URL.revokeObjectURL(this.fileUrl);
    this.fileUrl = undefined;
    await this.invoke("stop_global_audio").catch(() => {});
    this.vocal(0); this.speaking(false);
  }
}
