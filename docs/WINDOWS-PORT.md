# Windows 移植计划 (Windows Port Plan)

> 状态：调研阶段 ✅ → 待评审（未开工）
> 调研时间：2026-08-29
> 当前基线：v1.0.0 已发布（macOS-only），本计划规划 Windows 版移植

## 一句话结论

Windows 移植难度**中等偏低**。项目 95% 的代码是跨平台的（Live2D 渲染是纯 Web、状态机是纯 Python、连接器是纯本地复制），**真正要重写开发的只有两块**：① 全局音频采集（换成 WASAPI loopback，反而更好写）；② 点击穿透交互（Windows 没有 per-pixel alpha 穿透，架构要改）。核心架构不动。

---

## 一、移植难度总评估（修正后）

> ⚠️ 本表基于开源调研 + 对项目源码的实读（2026-08-29）。有一处推翻了最初判断：点击穿透不是「开箱可用」，见下方说明。

| 模块 | 难度 | 关键技术 | 改动量 |
|---|---|---|---|
| **Live2D 渲染** | 🟢 低 | PixiJS 8 + pixi-live2d-display + Cubism Core（纯 Web/WebGL） | 零改动，WebView2=Chromium |
| **状态机 + 数据格式** | 🟢 低 | `bridge/state_machine.py` 纯标准库 | 零改动，平台无关 |
| **连接器** | 🟢 低 | 全部纯本地复制（无 curl 下载） | 只改脚本语法（PowerShell 替代 bash） |
| **全局音频采集** | 🟢 低 | WASAPI loopback：`cpal` 14.6+ 或 `wasapi` crate | 新写 Rust 模块，~200 行 |
| **排除自身音频** | 🟢 低 | WASAPI Application Loopback（进程级） | `wasapi::new_application_loopback_client` 现成 API |
| **透明+置顶+无边框** | 🟢 低 | Tauri v2 原生配置 | 配置即可，1 个 ghost-titlebar 小坑 |
| **点击穿透交互** | 🟡 中 | **Windows 无 per-pixel alpha 穿透，需重写交互架构** | 唯一真难点，需全局钩子方案 |

### 🔴 已修正的判断：点击穿透是移植真难点

- **macOS 现状**（源码 `lib.rs` + `hit_test.rs`）：Tauri 在 macOS 上是**真·像素级穿透**——角色剪影内的像素可点、剪影外透明像素自动穿透。后台线程轮询光标 + 切换 `ignore_cursor_events`，WebView 能收到角色身上的事件。
- **Windows 差异**（调研确认）：`set_ignore_cursor_events(true)` 会让**整窗完全穿透**（角色身上也点不了）。官方 issue [#13070](https://github.com/tauri-apps/tauri/issues/13070)（2025-03，正是 Live2D 桌宠场景）被标 duplicate 关闭——**官方短期不打算做 per-pixel alpha 穿透**。
- **必须的方案**（CrabNebula koi-pond 桌宠同款）：整窗穿透 + **全局鼠标钩子**监听点击坐标 + 后端判定命中角色 → 临时切回 `set_ignore_cursor_events(false)` 接收事件。交互时序要重新设计。

---

## 二、分步实施计划（工作包）

> 估算基于 1 人（Dev 角色），不含双平台回归验收。

### WP0 — 工程骨架（0.5~1 天）
- 添加 Windows target，`tauri.conf.json` 加 `bundle.targets: ["nsis"]`、平台条件判断
- WebView2 依赖：Win11 内置 Runtime；Win10 需在安装器引导
- 首次无头构建能产出 exe

### WP1 — 透明 + 置顶 + 无边框（1 天）
- `transparent: true` + `decorations: false` + `alwaysOnTop: true`
- 实机验证 ghost-titlebar 坑（[#14764](https://github.com/tauri-apps/tauri/issues/14764)）+ 透明子窗口坑（[#12450](https://github.com/tauri-apps/tauri/issues/12450)）

### WP2 — 点击穿透交互重构（2~3 天，最重）
- 放弃 macOS 像素穿透，改整窗 `set_ignore_cursor_events(true)` + 全局鼠标钩子（`mouse_position` crate）判定命中
- 角色可拖拽/可点击时临时切回 `false`，交互时序重新设计
- 覆盖：点击遍历到角色事件、拖拽窗口、点击穿透到下层 app

### WP3 — 全局音频采集（1~2 天）
- 用 `wasapi` crate 写 `audio_capture.rs`（loopback + 排自身 + 算 RMS）
- **端点统一**：新模块对外只吐 `global-audio-level`（0~1 电平）事件，前端 `audio-source.ts` 一行不改
- 备选 `cpal` 14.6+（跨平台，未来可统一 macOS/Windows 两端音频栈）

### WP4 — 连接器 + 状态机（1~2 天，最轻松）
- install 脚本改 PowerShell 等价物（内容即「拷哪些文件、插哪个目录」不变）
- `hooks.json` 的 `/usr/bin/python3` → `python`（Windows 从 PATH 取）
- 状态机/bridge Python 侧零改动，在手上的 Win11 实测 harness 接线

### WP5 — 发布（2 天）
- **签名策略：先不签名（方案一已定）**，详见「签名策略」节。公开正式发布前再评估微软签名或商店上架
- NSIS 打包、升级机制（tauri updater）

**总估：约 12 个工作日（不含双平台回归验收）**

---

## 三、风险清单

| 风险 | 等级 | 应对 |
|---|---|---|
| WebView2 透明 + WebGL 合成历史兼容问题（[Feedback#526](https://github.com/MicrosoftEdge/WebView2Feedback/issues/526)） | 🟡 | WP1 前先做透明+WebGL smoke test（镜像可见性 / 角色渲染） |
| GPU 驱动异常回落 SwiftShader，Live2D 卡顿（Chromium 将移除 SwiftShader WebGL） | 🟡 | 目标 Win11+；渲染质量档位已做成菜单项，可降档 |
| 全程本地 hook 仍可能解引用失败或跟系统交互冲突 | 🟢 | koi-pond 成熟方案，多轮真机验收 |
| Win10 无 WebView2 Runtime | 🟢 | NSIS 引导安装 Runtime；或直接定 Win11 最低版本 |
| Windows 上 macOS 私有 API 相关代码残留编译冲突 | 🟢 | `cfg(target_os)` 门控 + Cargo features 平台隔离 |

---

## 四、Windows 版之后的后续 roadmap（v1.1+）

> 按「复用现有架构、放大核心资产」（纯 observer + 状态机 + Live2D 渲染层）筛选，优先级从高到低。

### 🟢 P0（复用架构，低成本高价值）
1. **更多 agent harness connector（1.1）** — 写个 connector 是既定扩展点（`docs/CONNECTORS.md` 有模板），成本最低、直接扩大生态接口。
2. **Windows 生态内打磨** — 适配 Windows 的快捷键、右键菜单、任务栏/托盘图标（Windows 无 macOS dock 毛玻璃，托盘是桌宠常驻的标准形态）。明确**不做 Linux 版**。

### 🟡 P1（放大生态 / 创作者）
3. **模型/皮肤市场（内容分发）** — 现在是「从 URL 或本地导入模型」，可做成应用内模型浏览 + 一键安装，官方托管 Live2D 免费模型。
4. **动作/表情创作工具** — 让用户可视化编排「状态 → 动作」映射，替代手改 `avatar.json`，降低创作者门槛。

### 🔵 P2（产品纵深）
5. **新 avatar runtime** — 架构文档明确写着「VRM、3D、像素风都只是 state 文件的消费者」。可做 VRM（Vroid 人物建模）或像素风精灵，扩 target audience。
6. **多 agent 并置展示** — 已支持多 harness，可升级为「多个桌宠一屏群像，每个侍候一个 agent」。
7. **桌面命令（点击角色触发动作 → 唤醒 agent）** — 目前纯 observer 只读；可加「显式触发」通道（角色点击 → 拉起点按指令），注意与「绝不越界」的安全定位平衡。

### ⚪ P3（长期探索）
8. **语音交互** — 目前只有「听」（audio 进嘴型），可加「说」（TTS）让 agent 状态变化时有语音播报。
9. **移动端 / 设置栏 web 化** — 状态文件本就跨平台，移动端可做「状态通知」而不做完整渲染。

---

## 五、签名策略（方案一：先不签名，延迟决策）

**当前决定（2026-08-29，作者在美国）：Windows 版开发/内测阶段不签名，公开正式发布前再评估签名方案。** 别让签名采购阻塞开发。

以下关键事实已调研核实（定价/机制/门槛来自微软官方文档与定价页）：
- Windows 不签名 ≠ 不能跑（比 macOS Gatekeeper 宽），但公开下载会吃一道 **SmartScreen 红色警告**（「无法验证发布者」），企业 EDR 可能直接阻断。技术用户可「更多信息→仍要运行」绕过，普通用户可能停在红屏。
- **签名 = 证书 + 盖章 + 时间戳**三件事。时间戳（RFC 3161）是关键：盖了才能「证书过期后已签名文件仍永久有效」。
- **Microsoft Artifact Signing**（Azure 代码签名）：官方 Basic **$9.99/月**（5,000 次签名）。**可买一个月就关闭**——短期证书（~3 天）+ 自动时间戳，**已签文件永久有效**。但门槛：需**付费 Azure 订阅** + Entra 租户 + **政府证件实人核验**（AU10TIX，1–20 工作日）。个人 Public Trust 证书**仅限美国/加拿大**（作者在美国，此项不构成障碍）。
- **GitHub 免费替代（Sigstore/cosign / Artifact Attestations）无效**——只做供应链来源证明，Windows 资源管理器不认，SmartScreen 照旧，用户看不到「发布者已验证」。不解决需求。

**节奏（延迟决策）**：
- 开发/内测阶段（当前）→ **不签名**：自己 Win11 实测，内测包自签名 + 用户 `Unblock-File` 即可
- 公开正式发布前 → **重新评估**，候选：微软 Artifact Signing（$9.99/月买一个月、Public Trust、作者在美国可过地域核验）或 Microsoft Store 上架（MSIX，商店代签、但要实测沙箱是否拦全局音频/穿透交互）
- 下单前若项目已积累下载/star，再权衡是否值得长期续费积累 SmartScreen 信誉

> SmartScreen 信誉是「证书有效期限 + 下载量」慢慢积累的，越早签名越早积累；但方案一不追求这个，等用户多了再说。

## 六、商业方向（长期，已记录思路，不实施）

> **核心前提（作者 2026-08-29 明确）：「用户量」是一切的前提。先获得用户、提升体验、新增并留住客户；有足够客户量了，再谈增值服务/变现。** 本节的商业思考均为「长线路标」，不在 Windows 版开发中实施，且默认以「已积累真实用户」为前提。

### 6.1 产品主线：让用户在应用内做出自己的专属桌宠（long-term）
- 愿景：把「从零到一只专属桌宠」的完整路径收进应用内，一站式体验。
- 用户可生成/自定义形象（捏人），我们搭框架 + 可接模型 API。
- **明确节奏**：这是 Windows 版完成之后、且面向「已有真实用户的程序」的长期主线。当前阶段不搭建、不接 API、不收费。
- 开放多个自有版权模型，同时预留「开放几个收费模型」的空间。

### 6.2 商业按阶段递进（前一步验证了才上后一步）
| 阶段 | 做什么 | 商业模式 | 复杂度 |
|---|---|---|---|
| 现在（Windows 版） | 顺滑导入外部模型 | 无（开源免费） | 低 |
| Windows 版后（近期） | 【验证】内置 2-3 个自有版权好看模型 + 本地半自定义（参数化） | 一次性买断（打包卖钱，验证付费意愿） | 中 |
| 用户说"还要"（中期） | 【扩展】开放第三方投稿模型 | 审核上架，先不做抽成 | 中高 |
| 用户基数大（长期重投入） | 【成熟】接 API 生成 + 模型市场/分发 + 抽成或订阅 | 流水分成/订阅 | 高 |

### 6.3 模型市场/抽成的本质前提（避免踩坑）
- 模型是开放的、可到处传的，程序也已有「从 URL 导入」能力 → 若市场「只是个下载器」则无锁定力，用户能免费绕开，抽不了成。
- **抽成的本质 = 平台必须提供「内容 + 体验」双重的、别处拿不到的独家价值**（如订阅持续更新、云同步、内容锁账号）。没有独家价值，市场抽成只是空壳。
- 因此「市场抽成」属**重投入的成熟期**方向；现阶段应走「一次买断的自有内容」（6.2 阶段 2），先验证付费意愿，而非提前搭市场基建。

### 6.4 长期方向备忘（Windows 版之后更远）
- 多 avatar runtime（VRM/像素风/纯状态条）——放大「任意皮肤都能读状态文件」的架构资产
- 应用内模型浏览 + 一键安装（roadmap P1）
- 若走传播：「分享 agent 状态瞬间」有画面感，但需数据脱敏（状态文件含工具调用文本）

## 七、待决事项

- [ ] **Windows 最低版本：Win10**（已定：需在 NSIS 安装器引导 WebView2 Runtime，或用 Evergreen Runtime 自动引导）——正式定档 Win10 支持
- [ ] **签名方案 = 先不签名 / 延迟决策**（已定，见「签名策略」节），公开正式发布前再评估微软签名或商店上架
- [ ] **开发实现方 = Claude Code**（已定，不建正式 Kanban 任务/不派 Dev PM）
- [ ] **商业方向**：仅记录，不实施（见「六、商业方向」），前提=用户量增长
