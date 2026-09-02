//! Windows 的全局音频采集 —— WASAPI loopback。
//!
//! 对应 macOS 的 `native/AudioCapture.m`（Core Audio process tap）。两者没有共同的抽象，
//! 所以各写各的；但**算法与对外口径必须一比一对齐**，否则同一段声音在两个平台上
//! 嘴张的幅度不一样。对齐的是这三件事：
//!
//! 1. 同样的带通（RBJ cookbook 双二阶，300Hz 高通 + 3400Hz 低通，Q = 1/√2），
//!    转置直接 II 型，滤波器状态跨缓冲保留 —— 每个缓冲边界重置会产生瞬态。
//! 2. 同样的上报节奏：每 16ms 一次，跳过的缓冲**能量累加**到下一次，瞬态不丢。
//! 3. 同样的两个事件：`global-audio-level`（0~1）与 `global-audio-error`。前端
//!    `audio-source.ts` 只认这两个，所以它一行都不用改。
//!
//! **与 macOS 的一个已知差异**：Core Audio 的 tap 能把本进程的声音排除在外，
//! 而这里抓的是整个输出端点的混音，**包含我们自己发出的声音**。目前不构成问题 ——
//! 全局音源与文件音源是互斥的（见 `AudioSourceController::start`），选了全局时应用自己不放音。
//! 真要排除，Windows 有进程级 loopback（`new_application_loopback_client`），
//! 但那条只能按进程 ID 包含/排除，要拿到「除我之外的所有进程」还得自己枚举，代价不小。
//!
//! 另外三条来自 Microsoft 的 Loopback Recording 文档，都影响这里的写法：
//!
//! - **事件驱动的 loopback 从 Windows 10 1703 起才受支持**。更早的版本收不到事件，
//!   官方给的绕法是另开一条 render 流去驱动。我们最低支持 Win10，实际在用的都远高于 1703，
//!   所以直接用事件驱动；cpal 仓库里那句「LOOPBACK 与 EVENTCALLBACK 不能同时用」
//!   说的是 1703 之前的情况，已经过时。
//! - **loopback 只能用共享模式**，独占模式不支持 —— 所以下面固定 `EventsShared`。
//! - **受 DRM 保护的音频抓不到**：可信音频驱动不允许 loopback 采集受保护内容。
//!   某些流媒体放歌时嘴不动，是这个原因，不是我们的 bug。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::Emitter;
use wasapi::{Direction, SampleType, StreamMode, WaveFormat};

const VOICE_LOW_HZ: f64 = 300.0;
const VOICE_HIGH_HZ: f64 = 3400.0;
/// 上报间隔。嘴型最快也只按帧率更新（30–60fps），逐缓冲上报是纯浪费的跨进程事件。
/// 与 macOS 的 `ECHO_REPORT_INTERVAL_SEC` 保持一致。
const REPORT_INTERVAL: Duration = Duration::from_millis(16);
/// 等一个音频事件最多多久。设备被拔掉时 WASAPI 不会主动报错，只是再也不触发事件 ——
/// 有超时才能把「静默地再也不动」变成一条明确的错误。
const EVENT_TIMEOUT_MS: u32 = 2000;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// 转置直接 II 型双二阶。系数取自 RBJ cookbook，按 a0 归一化 —— 与 macOS 侧同一份公式。
struct Biquad { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64, z1: f64, z2: f64 }

impl Biquad {
    fn new(sample_rate: f64, cutoff: f64, q: f64, highpass: bool) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * (cutoff / sample_rate);
        let (cosw, alpha) = (w0.cos(), w0.sin() / (2.0 * q));
        let a0 = 1.0 + alpha;
        let shared = if highpass { 1.0 + cosw } else { 1.0 - cosw };
        Self {
            b0: (shared / 2.0) / a0,
            b1: (if highpass { -shared } else { shared }) / a0,
            b2: (shared / 2.0) / a0,
            a1: (-2.0 * cosw) / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, input: f64) -> f64 {
        let y = self.b0 * input + self.z1;
        self.z1 = self.b1 * input - self.a1 * y + self.z2;
        self.z2 = self.b2 * input - self.a2 * y;
        y
    }
}

/// 只有这两个事件，写成两个具名函数而不是泛型 —— 前端 `audio-source.ts` 认的就是它们。
fn emit_level(level: f32) {
    if let Some(app) = crate::APP_HANDLE.get() { let _ = app.emit("global-audio-level", level); }
}

fn emit_error(reason: String) {
    if let Some(app) = crate::APP_HANDLE.get() { let _ = app.emit("global-audio-error", reason); }
}

/// 起采集线程。返回时**设备已经打开成功**，所以配置类失败（没有输出设备、格式不支持）
/// 是同步返回的 Err，而不是等一会儿才冒出来的事件 —— 前端据此可以立刻退回「关闭」。
pub fn start() -> Result<(), String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());   // 已经在跑；前端每次切音源都会先 stop 再 start，重复调用要幂等
    }
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        // COM 必须在**用它的那个线程**上初始化，所以在这里而不是调用方。
        let _ = wasapi::initialize_mta();
        match capture_loop(&ready_tx) {
            Ok(()) => {}
            Err(error) => {
                // 已经通知过 ready 的话，说明是跑起来之后才坏的（设备被拔等），走事件；
                // 否则是启动失败，ready_tx 那一端会收到它。
                let _ = ready_tx.send(Err(error.clone()));
                emit_error(error);
            }
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
    // 打开设备通常是毫秒级；给足余量但不能无限等，否则音源切换会把界面卡住。
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        Err(_) => {
            RUNNING.store(false, Ordering::SeqCst);
            Err("timed out opening the audio endpoint".to_owned())
        }
    }
}

pub fn stop() {
    if RUNNING.swap(false, Ordering::SeqCst) {
        // 与 macOS 一致：停下时补一个 0，否则嘴会停在最后一个音量上
        emit_level(0.0);
    }
}

fn capture_loop(ready: &mpsc::Sender<Result<(), String>>) -> Result<(), String> {
    let enumerator = wasapi::DeviceEnumerator::new().map_err(|e| format!("audio enumerator: {e}"))?;
    // **抓的是输出端点**：拿 Render 设备，却以 Capture 方向初始化 —— wasapi crate 据此
    // 加上 AUDCLNT_STREAMFLAGS_LOOPBACK。拿 Capture 设备会变成录麦克风，完全是另一件事。
    let device = enumerator.get_default_device(&Direction::Render)
        .map_err(|e| format!("no default output device: {e}"))?;
    let mut client = device.get_iaudioclient().map_err(|e| format!("audio client: {e}"))?;

    // 采样率跟随设备，不强求 44100 —— 强求会在 48k/96k 的设备上要么失败、要么多一次重采样。
    // 位深与声道数则统一成 f32 立体声，由 autoconvert 负责转换，省掉一堆格式分支。
    let mix = client.get_mixformat().map_err(|e| format!("mix format: {e}"))?;
    let sample_rate = mix.get_samplespersec();
    let format = WaveFormat::new(32, 32, &SampleType::Float, sample_rate as usize, 2, None);
    let block_align = format.get_blockalign() as usize;

    let (_default_period, min_period) = client.get_device_period().map_err(|e| format!("device period: {e}"))?;
    client.initialize_client(
        &format,
        &Direction::Capture,
        &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: min_period },
    ).map_err(|e| format!("initialize loopback: {e}"))?;

    let event = client.set_get_eventhandle().map_err(|e| format!("event handle: {e}"))?;
    let capture = client.get_audiocaptureclient().map_err(|e| format!("capture client: {e}"))?;
    client.start_stream().map_err(|e| format!("start stream: {e}"))?;

    // 到这里设备确实打开了，通知调用方可以返回 Ok 了
    let _ = ready.send(Ok(()));

    let mut highpass = Biquad::new(sample_rate as f64, VOICE_LOW_HZ, std::f64::consts::FRAC_1_SQRT_2, true);
    let mut lowpass = Biquad::new(sample_rate as f64, VOICE_HIGH_HZ, std::f64::consts::FRAC_1_SQRT_2, false);
    let mut queue: VecDeque<u8> = VecDeque::with_capacity(block_align * sample_rate as usize);
    let mut pending_sum = 0.0_f64;
    let mut pending_count = 0_u64;
    let mut last_report = Instant::now();

    while RUNNING.load(Ordering::SeqCst) {
        if event.wait_for_event(EVENT_TIMEOUT_MS).is_err() {
            // **超时不是错误，是「现在没声音」。** 官方文档并不保证音频引擎空闲时
            // 仍然触发事件，所以「没人放音乐」和「设备坏了」在这里长得一模一样。
            // 把它报成错误就会在用户只是没开音乐时弹一条假故障 —— 报 0 然后继续等，
            // 是唯一不会冤枉人的处理。真正的故障会由下面的 read 返回 Err。
            if !RUNNING.load(Ordering::SeqCst) { break; }
            emit_level(0.0);
            // 静默期间把滤波器状态清掉：留着的话，恢复放音时第一个缓冲会带着旧状态
            // 产生一次瞬态，表现为嘴突然抽一下。
            highpass = Biquad::new(sample_rate as f64, VOICE_LOW_HZ, std::f64::consts::FRAC_1_SQRT_2, true);
            lowpass = Biquad::new(sample_rate as f64, VOICE_HIGH_HZ, std::f64::consts::FRAC_1_SQRT_2, false);
            pending_sum = 0.0;
            pending_count = 0;
            continue;
        }
        capture.read_from_device_to_deque(&mut queue).map_err(|e| format!("read: {e}"))?;

        // 队列里是交织的 f32 字节流。**逐样本**滤波（滤波器必须连续），再求平方和 ——
        // 与 macOS 一样，所有声道当成一条流一起统计。
        while queue.len() >= 4 {
            let bytes = [queue.pop_front().unwrap(), queue.pop_front().unwrap(),
                         queue.pop_front().unwrap(), queue.pop_front().unwrap()];
            let sample = f32::from_le_bytes(bytes) as f64;
            let voiced = lowpass.process(highpass.process(sample));
            pending_sum += voiced * voiced;
            pending_count += 1;
        }

        if last_report.elapsed() >= REPORT_INTERVAL && pending_count > 0 {
            let level = (pending_sum / pending_count as f64).sqrt() as f32;
            emit_level(level.clamp(0.0, 1.0));
            pending_sum = 0.0;
            pending_count = 0;
            last_report = Instant::now();
        }
    }

    let _ = client.stop_stream();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 带通必须**放行人声频段、压掉两侧**。这是与 macOS 对齐的唯一可自动化的部分 ——
    /// 真正的采集要有音频设备，跑不进单元测试。
    fn response_at(hz: f64, sample_rate: f64) -> f64 {
        let mut highpass = Biquad::new(sample_rate, VOICE_LOW_HZ, std::f64::consts::FRAC_1_SQRT_2, true);
        let mut lowpass = Biquad::new(sample_rate, VOICE_HIGH_HZ, std::f64::consts::FRAC_1_SQRT_2, false);
        let frames = (sample_rate * 0.5) as usize;
        let mut sum = 0.0;
        let mut counted = 0.0;
        for index in 0..frames {
            let phase = 2.0 * std::f64::consts::PI * hz * (index as f64 / sample_rate);
            let out = lowpass.process(highpass.process(phase.sin()));
            // 跳过前 10% 让滤波器稳定下来，否则量到的是启动瞬态
            if index > frames / 10 { sum += out * out; counted += 1.0; }
        }
        (sum / counted).sqrt() / std::f64::consts::FRAC_1_SQRT_2   // 归一化到输入 RMS
    }

    #[test]
    fn the_band_pass_keeps_speech_and_rejects_what_drives_the_mouth_wrongly() {
        let rate = 48_000.0;
        // 人声带内基本原样通过
        assert!(response_at(1000.0, rate) > 0.9, "1kHz 被削掉了: {}", response_at(1000.0, rate));
        // 鼓与贝斯（<300Hz）能量最大、最容易把嘴顶开，必须显著衰减
        assert!(response_at(60.0, rate) < 0.1, "60Hz 没压住: {}", response_at(60.0, rate));
        // 镲片与齿音（>3400Hz）同理
        assert!(response_at(12_000.0, rate) < 0.2, "12kHz 没压住: {}", response_at(12_000.0, rate));
    }

    #[test]
    fn the_filter_is_stable_at_every_sample_rate_a_device_might_use() {
        // 采样率跟随设备，所以系数是按设备算的 —— 常见档位都不能发散
        for rate in [44_100.0, 48_000.0, 88_200.0, 96_000.0, 192_000.0] {
            let gain = response_at(1000.0, rate);
            assert!(gain.is_finite() && gain > 0.8, "{rate}Hz 下 1kHz 增益异常: {gain}");
        }
    }
}
