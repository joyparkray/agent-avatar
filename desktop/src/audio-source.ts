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
/** 幂曲线：保留音节差异，同时抬起较轻的辅音。 */
const CURVE = 0.7;
const ATTACK_MS = 45;
// 释放比攻击慢，但**不能太慢** —— 240ms 时字与字之间的空隙里嘴根本来不及闭上，
// 实测（真实 TTS 语音，两种音源各一份）静音帧里只有 32~50% 真的闭合，看起来就是「一直张着」。
// 缩到 90ms 后闭合率翻倍到 62~66%，而发声时的张开只掉约 2%。
const RELEASE_MS = 90;
/** 峰值回落的半衰期，用来适应系统音量变化。 */
const PEAK_HALF_LIFE_MS = 900;
/**
 * 判定「有没有声音」与「多大算大声」的两个**原始域**参照。
 *
 * - 噪声门：低于它一律当静音。
 * - 峰值下限：归一化的分母有个底，否则完全安静时任何一点底噪都会被归一化成满量程。
 *
 * 灵敏度调的就是这两个（见 setLipSensitivity），**不是开口阈值**。
 * 原因见那里的注释 —— 这是实测踩出来的。
 */
// 这两个值是拿**两份真实语音**扫出来的：一份走文件音源（振幅是文件自己的，最大 0.24），
// 一份走 WASAPI loopback（受系统音量衰减，最大只有 0.022，差一个数量级）。
// 旧值 0.008/0.04 对文件源没问题，但在 loopback 下只能让嘴张开 6.4% —— 因为峰值下限 0.04
// 比整段语音的最大值还高，归一化的分母被卡死，再大的声音也被压扁。
// 新值让两种音源都落在 92~96% 张开、62~70% 闭合。
const BASE_NOISE_FLOOR = 0.002;
const BASE_PEAK_FLOOR = 0.010;
/** 开口/闭口阈值，作用在**归一化之后**的包络上。归一化已经自适应音量，所以这两个不用跟着灵敏度动。 */
const OPEN_AT = 0.06;
const CLOSE_AT = 0.02;
/** 设置页的电平条要在同一位置画参考线 —— 两处各写一个数字必然漂。 */
/**
 * 设置页电平条要显示的两样东西。
 *
 * 柱子画**原始音量**、线画**开口门槛**，而不是反过来 —— 音频表的常规读法是
 * 「信号是客观的，阈值是你调的」。画成归一化之后的包络的话，拉灵敏度会让柱子动、
 * 线不动，看起来像是「调音量」，与直觉相反。
 */
export const LIP_OPEN_ENVELOPE = OPEN_AT;

/**
 * 让嘴开始张开所需要的**原始**音量。这就是电平条上那条线的位置，随灵敏度移动。
 *
 * 推导：嘴在包络 >= OPEN_AT 时张开，而稳态下包络趋近 `normalized ** CURVE`，
 * 所以 `normalized >= OPEN_AT ** (1/CURVE)`；再代入归一化的定义
 * `(x - 噪声门) / (峰值 - 噪声门)`，安静时峰值就是峰值下限。
 */
export function openRawLevelFor(sensitivityPercent: number): number {
  const scale = referenceScaleFor(sensitivityPercent);
  const nf = BASE_NOISE_FLOOR * scale, pf = BASE_PEAK_FLOOR * scale;
  return nf + Math.pow(OPEN_AT, 1 / CURVE) * (pf - nf);
}

/**
 * 最近一次进来的**原始**音量，供设置页的电平条显示。
 *
 * 放在模块级而不是实例上：三种音源各有一个 tracker，但**同时只有一个在跑**
 *（切音源时会先 stop 再 start），所以谁在跑就是谁在写。只作诊断显示，不参与任何判定。
 */
export let lastRawLevel = 0;

let noiseFloor = BASE_NOISE_FLOOR;
let peakFloor = BASE_PEAK_FLOOR;

/**
 * 灵敏度百分比 → 参照值的倍率。每 25% 差一倍：
 * 0% → ×4（要很大声才算说话）、50% → ×1（默认，即本设置出现前的固定行为）、100% → ×0.25。
 *
 * 用倍率而不是线性插值：这是个「多小算有声音」的量，感知上是对数的，
 * 线性映射会让滑块前半段几乎没变化、后半段突变。
 */
export function referenceScaleFor(sensitivityPercent: number): number {
  const clamped = Math.max(0, Math.min(100, sensitivityPercent));
  return Math.pow(2, (50 - clamped) / 25);
}

/**
 * **模块级共享**：三种音源各有一个 `GlobalLevelTracker` 实例
 * （global/file 用 AudioSourceController 的，hermes 用 VoiceDriver 的），
 * 而灵敏度是一个全局设置 —— 存在实例上就得挨个设，漏一个就是「Hermes 调了没反应」。
 *
 * **为什么调的是参照而不是开口阈值**：实测一段偏轻的音频，原始 RMS 只有 0.009，
 * 而噪声门就是 0.008 —— 归一化算出来 (0.009-0.008)/(0.04-0.008) ≈ 0.03，
 * 包络只到 0.09。这时候再怎么降开口阈值，嘴也只开 9%，纯粹是「不抖了但还是看不见」。
 * 把参照一起缩小（噪声门 0.002、峰值下限 0.01）之后，同一段音频归一化到 0.875，
 * 包络 0.91 —— 嘴才是真的张开。
 */
export function setLipSensitivity(sensitivityPercent: number): void {
  const scale = referenceScaleFor(sensitivityPercent);
  noiseFloor = BASE_NOISE_FLOOR * scale;
  peakFloor = BASE_PEAK_FLOOR * scale;
}

export class GlobalLevelTracker {
  private envelope = 0;
  // 起步值也要跟着灵敏度走 —— 只改 reset() 的话，新建的 tracker 会带着旧参照起步，
  // 表现是「刚切到这个音源的头一秒手感不对」。
  private peak = peakFloor;
  private active = false;
  private last?: number;

  update(raw: number, now: number = performance.now()): { level: number; speaking: boolean } {
    // 首帧与异常间隔都按一帧处理，避免长时间静默后跳变
    const elapsed = this.last === undefined ? 16 : Math.min(200, Math.max(1, now - this.last));
    this.last = now;
    const input = Math.max(0, Math.min(1, raw));
    lastRawLevel = input;
    this.peak = Math.max(peakFloor, input, this.peak * Math.pow(0.5, elapsed / PEAK_HALF_LIFE_MS));
    const normalized = input < noiseFloor ? 0 : Math.min(1, (input - noiseFloor) / Math.max(0.001, this.peak - noiseFloor));
    // 幂曲线保留音节差异，同时抬起较轻的辅音
    const target = Math.pow(normalized, CURVE);
    const constant = target > this.envelope ? ATTACK_MS : RELEASE_MS;
    this.envelope += (target - this.envelope) * (1 - Math.exp(-elapsed / constant));
    if (!this.active && this.envelope >= OPEN_AT) this.active = true;
    else if (this.active && this.envelope <= CLOSE_AT) this.active = false;
    return { level: this.active ? this.envelope : 0, speaking: this.active };
  }

  reset(): { level: 0; speaking: false } {
    this.envelope = 0; this.peak = peakFloor; this.active = false; this.last = undefined;
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
