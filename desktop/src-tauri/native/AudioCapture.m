// 系统音频捕获 —— Core Audio Process Tap（macOS 14.2+）。
//
// 为什么不用 ScreenCaptureKit：SCK 是「屏幕录制形状」的 API，抓纯音频也要屏幕录制权限，
// 并且会在菜单栏常驻录制指示器 —— 对一个常驻的桌面陪伴应用来说，要价和观感都过重。
// Core Audio Tap 是 Apple 为「只要音频」补的专用通道：权限为音频捕获
// （Info.plist 的 NSAudioCaptureUsageDescription），无录制指示器。
//
// 流程（对照 CoreAudio/AudioHardwareTapping.h 与 AudioHardware.h 的常量）：
//   CATapDescription(全局、排除自身) → AudioHardwareCreateProcessTap
//   → 读 kAudioTapPropertyFormat 与 kAudioTapPropertyUID
//   → 以该 tap 建私有聚合设备 → AudioDeviceCreateIOProcIDWithBlock → AudioDeviceStart
// 回调里算 RMS 后上报，取整段缓冲的均方根，与 Hermes 音源口径一致。
#import <Accelerate/Accelerate.h>
#import <QuartzCore/QuartzCore.h>   // CACurrentMediaTime
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <Foundation/Foundation.h>

typedef void (*EchoLevelCallback)(float);

// 人声频段（电话带宽）。混音里的鼓与贝斯能量最大、最容易把嘴顶开，而它们基本落在 300 Hz 以下；
// 3400 Hz 以上主要是镲片与齿音。带通到这一段能明显削掉非人声的驱动，但**不是人声分离** ——
// 落在同一频段的吉他、人声和声等仍会驱动嘴型，那需要音源分离，实时场景不现实。
#define ECHO_VOICE_LOW_HZ 300.0
#define ECHO_VOICE_HIGH_HZ 3400.0

/** 转置直接 II 型双二阶；状态需跨回调保留，否则每个缓冲边界都会产生瞬态。 */
typedef struct { double b0, b1, b2, a1, a2, z1, z2; } EchoBiquad;

static void EchoBiquadReset(EchoBiquad *filter) { filter->z1 = 0.0; filter->z2 = 0.0; }

/** RBJ cookbook 系数，统一按 a0 归一化。 */
static void EchoBiquadInit(EchoBiquad *filter, double sampleRate, double cutoff, double q, bool highpass) {
    const double w0 = 2.0 * M_PI * (cutoff / sampleRate);
    const double cosw = cos(w0), alpha = sin(w0) / (2.0 * q);
    const double a0 = 1.0 + alpha;
    const double shared = highpass ? (1.0 + cosw) : (1.0 - cosw);
    filter->b0 = (shared / 2.0) / a0;
    filter->b1 = (highpass ? -shared : shared) / a0;
    filter->b2 = filter->b0;
    filter->a1 = (-2.0 * cosw) / a0;
    filter->a2 = (1.0 - alpha) / a0;
    EchoBiquadReset(filter);
}

static inline float EchoBiquadProcess(EchoBiquad *filter, float input) {
    const double y = filter->b0 * input + filter->z1;
    filter->z1 = filter->b1 * input - filter->a1 * y + filter->z2;
    filter->z2 = filter->b2 * input - filter->a2 * y;
    return (float)y;
}

static EchoLevelCallback g_callback = NULL;
static AudioObjectID g_tap = kAudioObjectUnknown;
static AudioObjectID g_aggregate = kAudioObjectUnknown;
static AudioDeviceIOProcID g_proc = NULL;
static dispatch_queue_t g_queue = NULL;
static EchoBiquad g_highpass, g_lowpass;
/**
 * 上报间隔。CoreAudio 每个缓冲回调一次（512 帧 @48k ≈ 10.7ms，约 93 次/秒），
 * 而嘴型最快也只按帧率更新（30–60fps），逐缓冲上报是纯浪费的跨进程事件。
 * 跳过的缓冲不丢弃：能量累加到下一次一并计入，瞬态不会漏。
 */
#define ECHO_REPORT_INTERVAL_SEC 0.016
static double g_pending_sum = 0.0;
static UInt32 g_pending_count = 0;
static double g_last_report = 0.0;
static char g_last_error[160] = {0};

static void EchoFail(const char *step, OSStatus status) {
    snprintf(g_last_error, sizeof(g_last_error), "%s failed: OSStatus %d", step, (int)status);
}

const char *echo_global_audio_last_error(void) { return g_last_error[0] ? g_last_error : "unknown"; }

API_AVAILABLE(macos(14.2))
static NSString *EchoDefaultOutputUID(void) {
    AudioObjectID device = kAudioObjectUnknown;
    UInt32 size = sizeof(device);
    AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultOutputDevice,
                                           kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &device) != noErr) return nil;
    CFStringRef uid = NULL;
    size = sizeof(uid);
    address.mSelector = kAudioDevicePropertyDeviceUID;
    if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &uid) != noErr || !uid) return nil;
    return (__bridge_transfer NSString *)uid;
}

/**
 * 把 Unix PID 换成 Core Audio 的进程对象 ID。
 * `initMonoGlobalTapButExcludeProcesses:` 要的是 AudioObjectID 而**不是** PID ——
 * 直接传 getpid() 会让 AudioHardwareCreateProcessTap 返回 '!obj'
 * （kAudioHardwareBadObjectError），且失败发生在权限检查之前，因此连授权弹窗都不会出现。
 * 注意：PID 不存在时该属性不报错，而是返回 kAudioObjectUnknown。
 */
API_AVAILABLE(macos(14.2))
static AudioObjectID EchoProcessObjectForPID(pid_t pid) {
    AudioObjectID object = kAudioObjectUnknown;
    UInt32 size = sizeof(object);
    AudioObjectPropertyAddress address = { kAudioHardwarePropertyTranslatePIDToProcessObject,
                                           kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, sizeof(pid), &pid, &size, &object) != noErr)
        return kAudioObjectUnknown;
    return object;
}

API_AVAILABLE(macos(14.2))
static OSStatus EchoTapProperty(AudioObjectID tap, AudioObjectPropertySelector selector, void *out, UInt32 *size) {
    AudioObjectPropertyAddress address = { selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    return AudioObjectGetPropertyData(tap, &address, 0, NULL, size, out);
}

static void EchoTeardown(void) {
    if (@available(macOS 14.2, *)) {
        if (g_aggregate != kAudioObjectUnknown && g_proc) {
            AudioDeviceStop(g_aggregate, g_proc);
            AudioDeviceDestroyIOProcID(g_aggregate, g_proc);
        }
        if (g_aggregate != kAudioObjectUnknown) AudioHardwareDestroyAggregateDevice(g_aggregate);
        if (g_tap != kAudioObjectUnknown) AudioHardwareDestroyProcessTap(g_tap);
    }
    g_proc = NULL;
    g_aggregate = kAudioObjectUnknown;
    g_tap = kAudioObjectUnknown;
}

void echo_global_audio_start(EchoLevelCallback callback) {
    if (@available(macOS 14.2, *)) {
        EchoTeardown();
        g_callback = callback;

        // 排除自身，避免把 app 自己的输出再抓回来形成回环
        AudioObjectID selfObject = EchoProcessObjectForPID(getpid());
        NSArray<NSNumber *> *exclude = selfObject != kAudioObjectUnknown ? @[ @(selfObject) ] : @[];
        CATapDescription *description =
            [[CATapDescription alloc] initMonoGlobalTapButExcludeProcesses:exclude];
        description.name = @"Agent Avatar Global Audio";
        description.UUID = [NSUUID UUID];
        description.muteBehavior = CATapUnmuted;   // 只监听，不影响正常播放

        OSStatus status = AudioHardwareCreateProcessTap(description, &g_tap);
        if (status != noErr || g_tap == kAudioObjectUnknown) {
            EchoFail("AudioHardwareCreateProcessTap", status);
            if (g_callback) g_callback(-1);
            g_callback = NULL;
            return;
        }

        AudioStreamBasicDescription format = {0};
        UInt32 size = sizeof(format);
        CFStringRef tapUID = NULL;
        UInt32 uidSize = sizeof(tapUID);
        OSStatus formatStatus = EchoTapProperty(g_tap, kAudioTapPropertyFormat, &format, &size);
        OSStatus uidStatus = EchoTapProperty(g_tap, kAudioTapPropertyUID, &tapUID, &uidSize);
        if (formatStatus != noErr || uidStatus != noErr || !tapUID) {
            EchoFail("read tap properties", formatStatus != noErr ? formatStatus : uidStatus);
            EchoTeardown();
            if (g_callback) g_callback(-1);
            g_callback = NULL;
            return;
        }
        NSString *tapUIDString = (__bridge_transfer NSString *)tapUID;
        NSString *outputUID = EchoDefaultOutputUID();

        NSMutableDictionary *aggregate = [@{
            @(kAudioAggregateDeviceNameKey): @"Agent Avatar Tap",
            @(kAudioAggregateDeviceUIDKey): [[NSUUID UUID] UUIDString],
            @(kAudioAggregateDeviceIsPrivateKey): @YES,      // 不出现在系统声音设置里
            @(kAudioAggregateDeviceIsStackedKey): @NO,
            @(kAudioAggregateDeviceTapAutoStartKey): @YES,
            @(kAudioAggregateDeviceTapListKey): @[ @{
                @(kAudioSubTapUIDKey): tapUIDString,
                @(kAudioSubTapDriftCompensationKey): @YES,
            } ],
        } mutableCopy];
        if (outputUID) {
            aggregate[@(kAudioAggregateDeviceMainSubDeviceKey)] = outputUID;
            aggregate[@(kAudioAggregateDeviceSubDeviceListKey)] = @[ @{ @(kAudioSubDeviceUIDKey): outputUID } ];
        }

        OSStatus aggregateStatus = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregate, &g_aggregate);
        if (aggregateStatus != noErr) {
            EchoFail("AudioHardwareCreateAggregateDevice", aggregateStatus);
            EchoTeardown();
            if (g_callback) g_callback(-1);
            g_callback = NULL;
            return;
        }

        const double sampleRate = format.mSampleRate > 0 ? format.mSampleRate : 48000.0;
        EchoBiquadInit(&g_highpass, sampleRate, ECHO_VOICE_LOW_HZ, M_SQRT1_2, true);
        EchoBiquadInit(&g_lowpass, sampleRate, ECHO_VOICE_HIGH_HZ, M_SQRT1_2, false);
        g_pending_sum = 0.0; g_pending_count = 0; g_last_report = 0.0;

        if (!g_queue) g_queue = dispatch_queue_create("io.github.joyparkray.agentavatar.audio", DISPATCH_QUEUE_SERIAL);
        const UInt32 channels = format.mChannelsPerFrame ? format.mChannelsPerFrame : 1;
        AudioDeviceIOBlock block = ^(const AudioTimeStamp *now, const AudioBufferList *input,
                                     const AudioTimeStamp *inputTime, AudioBufferList *output,
                                     const AudioTimeStamp *outputTime) {
            (void)now; (void)inputTime; (void)output; (void)outputTime;
            if (!input || !g_callback) return;
            double sum = 0.0;
            UInt32 total = 0;
            for (UInt32 i = 0; i < input->mNumberBuffers; i++) {
                const AudioBuffer buffer = input->mBuffers[i];
                if (!buffer.mData || !buffer.mDataByteSize) continue;
                const UInt32 count = buffer.mDataByteSize / sizeof(float);
                const float *samples = (const float *)buffer.mData;
                // 带通后再求均方 —— 滤波必须逐样本且状态连续，故不能用 vDSP_measqv 对原始缓冲整体求值
                for (UInt32 s = 0; s < count; s++) {
                    const float voiced = EchoBiquadProcess(&g_lowpass, EchoBiquadProcess(&g_highpass, samples[s]));
                    sum += (double)voiced * (double)voiced;
                }
                total += count;
            }
            if (!total) return;
            (void)channels;
            g_pending_sum += sum;
            g_pending_count += total;
            const double stamp = CACurrentMediaTime();
            if (stamp - g_last_report < ECHO_REPORT_INTERVAL_SEC) return;
            g_last_report = stamp;
            const float level = (float)sqrt(g_pending_sum / (double)g_pending_count);
            g_pending_sum = 0.0;
            g_pending_count = 0;
            g_callback(level);
        };

        OSStatus procStatus = AudioDeviceCreateIOProcIDWithBlock(&g_proc, g_aggregate, g_queue, block);
        OSStatus startStatus = procStatus == noErr ? AudioDeviceStart(g_aggregate, g_proc) : procStatus;
        if (startStatus != noErr) {
            EchoFail(procStatus != noErr ? "AudioDeviceCreateIOProcIDWithBlock" : "AudioDeviceStart", startStatus);
            EchoTeardown();
            if (g_callback) g_callback(-1);
            g_callback = NULL;
        }
        return;
    }
    // 低于 macOS 14.2：无音频专用捕获通道，直接报错而不是退回屏幕录制那条重路径
    EchoFail("Core Audio process tap requires macOS 14.2", -1);
    if (callback) callback(-1);
}

void echo_global_audio_stop(void) {
    EchoTeardown();
    if (g_callback) g_callback(0);
    g_callback = NULL;
}
