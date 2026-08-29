import { afterEach, describe, expect, it, vi } from "vitest"; import { ClipLevelTimeline, MonotonicScheduler, rms } from "./audio"; import { SemanticDriver } from "./semantic";
import { AudioSourceController } from "./audio-source"; import { AvatarDirector } from "./director"; import { loadManifest } from "./manifest";
import { decodeAudioDataUrl, VoiceDriver, voiceWebSocketUrl } from "./voice";
import { GlobalLevelTracker } from "./audio-source";
import { loadTextures } from "pixi.js"; import "./pixi";
describe("live2d textures",()=>{it("uses Image instead of createImageBitmap",()=>expect(loadTextures.config).toEqual({preferWorkers:false,preferCreateImageBitmap:false,crossOrigin:"anonymous"}))});
describe("audio",()=>{it("calculates RMS",()=>expect(rms([1,-1,1,-1])).toBe(1));it("splits a clip into frames on the playback clock",()=>{
    // 1 秒 @ 1000Hz：前半段有声、后半段静音。切成 50ms 帧后应能分辨出前后差异，
    // 而不是整段一个 RMS（那正是 edge 这类非流式 TTS 下嘴巴张着不动的原因）。
    const rate=1000,samples=new Float32Array(rate);for(let i=0;i<rate/2;i++)samples[i]=1;
    const timeline=new ClipLevelTimeline(.05);timeline.push(samples,rate,10);
    expect(timeline.advance(9.9)).toBeUndefined();          // 还没到播放时刻
    expect(timeline.advance(10)).toBeCloseTo(1,6);           // 有声帧
    expect(timeline.advance(10.6)).toBe(0);                  // 静音帧
    expect(timeline.pending).toBe(true);
    timeline.advance(99);expect(timeline.pending).toBe(false);
    timeline.push(samples,rate,0);timeline.reset();expect(timeline.pending).toBe(false)});it("schedules 60 seconds without drift",()=>{const s=new MonotonicScheduler(.075);let expected=.075;for(let i=0;i<6000;i++){const at=s.schedule(i/100,.01);expect(at).toBeCloseTo(expected,8);expected+=.01;}expect(s.nextStartAt).toBeCloseTo(60.075,8)})});
describe("global audio level", () => {
  /** 按固定步长推进时间 —— 包络是时间常数驱动的，不能靠调用次数。 */
  const drive = (tracker: GlobalLevelTracker, raw: number, ms: number, stepMs = 10) => {
    let frame = { level: 0, speaking: false };
    for (let t = 0; t < ms; t += stepMs) frame = tracker.update(raw, t);
    return frame;
  };

  it("gates low-level noise without mouth twitch", () => {
    const tracker = new GlobalLevelTracker();
    [0.001, 0.005, 0.007, 0.003, 0.006].forEach((raw, i) =>
      expect(tracker.update(raw, i * 10)).toEqual({ level: 0, speaking: false }));
  });

  it("opens on a syllable and preserves loud/quiet contrast", () => {
    const tracker = new GlobalLevelTracker();
    const loud = drive(tracker, 0.2, 200);
    expect(loud.speaking).toBe(true);
    const quiet = drive(tracker, 0.015, 400);
    expect(quiet.level).toBeLessThan(loud.level);
  });

  // 跟着音乐哼唱：释放明显慢于攻击，否则每个鼓点都会把嘴合上再弹开
  it("releases far slower than it attacks", () => {
    const attack = new GlobalLevelTracker();
    const opened = drive(attack, 0.5, 60).level;
    const release = new GlobalLevelTracker();
    drive(release, 0.5, 300);
    const decayed = drive(release, 0, 60).level;
    expect(opened).toBeGreaterThan(0.5);        // 60ms 内基本张开
    expect(decayed).toBeGreaterThan(0.4);       // 同样 60ms 内几乎没合上
  });

  it("closes once the music actually stops", () => {
    const tracker = new GlobalLevelTracker();
    drive(tracker, 0.5, 300);
    expect(drive(tracker, 0, 1500)).toEqual({ level: 0, speaking: false });
  });

  // 回调间隔在全局（约 10ms）与文件（约 16ms）音源下不同，同一段时间的结果必须一致
  it("behaves the same regardless of callback rate", () => {
    const fast = new GlobalLevelTracker(), slow = new GlobalLevelTracker();
    const a = drive(fast, 0.3, 300, 10).level;
    const b = drive(slow, 0.3, 300, 25).level;
    expect(Math.abs(a - b)).toBeLessThan(0.02);
  });

  it("adapts to quiet music instead of leaving the mouth barely open", () => {
    expect(drive(new GlobalLevelTracker(), 0.02, 300).level).toBeGreaterThan(0.2);
  });

  it("reset closes immediately", () => {
    const tracker = new GlobalLevelTracker();
    drive(tracker, 0.5, 200);
    expect(tracker.reset()).toEqual({ level: 0, speaking: false });
  });
});

describe("semantic polling",()=>{afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()});it("backs off while the backend is absent and recovers the moment it returns",async()=>{
    vi.useFakeTimers();vi.stubGlobal("window",globalThis);
    let snapshot:any=null;const read=vi.fn(async()=>snapshot);
    const driver=new SemanticDriver(read,vi.fn(),100,800);
    driver.start();
    await vi.advanceTimersByTimeAsync(3000);
    const idleCalls=read.mock.calls.length;
    // 固定 100ms 会是约 30 次；退避后应显著少于此
    expect(idleCalls).toBeLessThan(15);
    snapshot={state:"executing",sequence:1};
    await vi.advanceTimersByTimeAsync(1600);   // 至少覆盖一个最大退避周期
    const recovered=read.mock.calls.length-idleCalls;
    await vi.advanceTimersByTimeAsync(1000);
    expect(read.mock.calls.length-idleCalls-recovered).toBeGreaterThan(5);   // 已回到快频率
    driver.stop();
  });
  it("re-emits after the state file is rebuilt and sequence restarts",async()=>{vi.useFakeTimers();vi.stubGlobal("window",globalThis);
    const snapshots=[{state:"executing",sequence:9},{state:"idle",sequence:1}];let index=0;
    const emit=vi.fn(),driver=new SemanticDriver(async()=>snapshots[Math.min(index++,snapshots.length-1)],emit,100,100);
    driver.start();await vi.advanceTimersByTimeAsync(400);driver.stop();
    expect(emit.mock.calls.map(([state])=>state)).toEqual(["executing","idle"])});
  it.each([["same sequence",async()=>({state:"idle",sequence:7})],["offline backend",async()=>null]])("emits idle once for %s",async(_name,read)=>{vi.useFakeTimers();vi.stubGlobal("window",globalThis);const emit=vi.fn(),driver=new SemanticDriver(read,emit);driver.start();await vi.advanceTimersByTimeAsync(1000);driver.stop();expect(emit).toHaveBeenCalledTimes(1);expect(emit).toHaveBeenCalledWith("idle")})});
describe("hermes endpoint retarget",()=>{
  // token 不是启动时就有的：desktop 每次启动重新生成，由 hook 写进状态文件后皮肤才读到；
  // desktop 重启还会换端口。端点必须能在运行中更新，否则用户得重启皮肤。
  const build=(endpoint:{url:string;token?:string;path:string}|null)=>{
    const voice={reset:vi.fn(),connect:vi.fn()} as unknown as ConstructorParameters<typeof AudioSourceController>[0];
    const controller=new AudioSourceController(voice,endpoint,async()=>undefined,vi.fn(),vi.fn(),vi.fn());
    return {voice:voice as unknown as {connect:ReturnType<typeof vi.fn>},controller};
  };
  it("reconnects when the token arrives",async()=>{
    const {voice,controller}=build({url:"http://127.0.0.1:1",token:"",path:"/p"});
    await controller.retarget({url:"http://127.0.0.1:1",token:"tok",path:"/p"});
    expect(voice.connect).toHaveBeenCalledWith("http://127.0.0.1:1","tok","/p")});
  it("stays put when nothing changed",async()=>{
    const {voice,controller}=build({url:"http://127.0.0.1:1",token:"tok",path:"/p"});
    await controller.retarget({url:"http://127.0.0.1:1",token:"tok",path:"/p"});
    expect(voice.connect).not.toHaveBeenCalled()});
  it("does not hijack another audio source",async()=>{
    const {voice,controller}=build({url:"http://127.0.0.1:1",token:"",path:"/p"});
    await controller.start("file");
    await controller.retarget({url:"http://127.0.0.1:1",token:"tok",path:"/p"});
    expect(voice.connect).not.toHaveBeenCalled();
    expect(controller.current).toBe("file")});
  it("turns all audio driving off without connecting another source",async()=>{
    const {voice,controller}=build({url:"http://127.0.0.1:1",token:"tok",path:"/p"});
    await controller.start("off");
    expect(controller.current).toBe("off");
    expect(voice.connect).not.toHaveBeenCalled()});
});
describe("director",()=>{it("zeros in stop path",()=>{const m={load:vi.fn(),setVocalLevel:vi.fn(),playSemantic:vi.fn(),playReaction:vi.fn(),applyEmotion:vi.fn(),reset:vi.fn(),resetExpression:vi.fn(),destroy:vi.fn()};const d=new AvatarDirector(m);d.setTalking(true);d.stop();expect(m.reset).toHaveBeenCalled();expect(m.playSemantic).toHaveBeenLastCalledWith("idle",true)})});
describe("manifest",()=>{it("loads a complete swappable manifest",async()=>{const motions=Object.fromEntries(["idle","writing","researching","executing","syncing","error"].map(state=>[state,["Idle",0]]));const f=vi.fn(async url=>({ok:true,json:async()=>String(url).endsWith("/x")?{FileReferences:{Motions:{Idle:[{}]}}}:{id:"avatar",version:"1",cubismVersion:4,model:"x",motions}})) as any;expect((await loadManifest({baseUrl:"/models/avatar",manifest:"avatar.json"},f)).id).toBe("avatar")});it("rejects invalid",async()=>await expect(loadManifest({baseUrl:"x",manifest:"avatar.json"},async()=>({ok:true,json:async()=>({})}) as any)).rejects.toThrow("invalid"))});
describe("voice protocol",()=>{it("uses the authenticated observer endpoint",()=>expect(voiceWebSocketUrl("http://127.0.0.1:1234","a b")).toBe("ws://127.0.0.1:1234/api/audio/observe?token=a%20b"));it("keeps the mock path configurable",()=>expect(voiceWebSocketUrl("http://127.0.0.1:1234","","/api/audio/speak-stream")).toBe("ws://127.0.0.1:1234/api/audio/speak-stream"));it("decodes a fallback audio data URL",()=>expect([...new Uint8Array(decodeAudioDataUrl("data:audio/wav;base64,AQID"))]).toEqual([1,2,3]));it("rejects missing fallback audio",()=>expect(()=>decodeAudioDataUrl("not-data")).toThrow("invalid audio data URL"));it("logs resets through the optional diagnostic channel",()=>{const log=vi.fn();new VoiceDriver(log).reset();expect(log).toHaveBeenCalledWith(expect.objectContaining({event:"voice-reset",level:0}))})});
