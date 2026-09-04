# Agent Avatar

<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="Agent Avatar 猫耳形象图标">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

<p align="center">
  <a href="https://github.com/joyparkray/agent-avatar/actions/workflows/ci.yml"><img src="https://github.com/joyparkray/agent-avatar/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/macOS-14.2%2B-lightgrey" alt="macOS 14.2+">
  <img src="https://img.shields.io/badge/Windows-10%2B-lightgrey" alt="Windows 10+">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT licence">
</p>

<p align="center">
  <strong>给你的 AI 编程 Agent 一个真正待在桌面上的「身体」。</strong>
</p>

Agent Avatar 会把**你正在使用的 coding agent 的真实运行状态**，变成一个一眼就能看懂的
Live2D 桌面形象。

Agent 在思考，它就思考；工具在执行，它就忙起来；Agent 在审阅、报错，或者**停下来等你输入**，
你不用为了确认进度再切回终端看一眼。

它**不是给一个独立聊天机器人套上二次元外壳**。Agent Avatar 不替代你的 Agent，
也不把你锁在某一家 AI 上。它接在 Claude Code、Codex、Hermes、DeepSeek Harness 或
WorkBuddy 旁边，把它们正在做的事情直接带到桌面上。

**macOS + Windows · 五家 Agent Connector，都只要点一下 · Live2D 形象自由更换**

<p align="center">
  <a href="../../releases"><b>下载</b></a> ·
  <a href="docs/QUICKSTART.zh.md">快速上手</a> ·
  <a href="docs/CONNECTORS.md">Agent 接入</a>
</p>

<p align="center">
  <img src="assets/screenshots/desktop.png" width="900" alt="桌面上的 Agent Avatar，旁边是 agent 会话，状态显示 Thinking">
</p>

---

## 它和普通桌宠 / AI Avatar 有什么不同？

普通桌宠可以很可爱，也可以有很多交互；AI Avatar 也可以聊天。Agent Avatar 的重点是另一件事：
**不换掉你原来使用的 Coding Agent，只把它变得可见。**

| | 一般桌宠 / 独立 AI Avatar | **Agent Avatar** |
|---|---|---|
| **什么在驱动形象** | 闲置动画、点击，或它自己的聊天模型 | **你现有 Coding Agent 的真实事件** |
| **你能看出什么** | 大多只能看出角色有没有在动 | **思考、工具执行、等待你、审阅、同步、报错** |
| **绑定哪家 AI** | 通常和一个 App / 后端绑定 | **Claude Code、Codex、Hermes、DeepSeek Harness、WorkBuddy** |
| **绑定哪个角色** | 经常是固定角色或专用格式 | **大多数 Live2D Cubism 3/4/5 模型** |
| **同时跑多个 Agent** | 通常不是主要场景 | **自动跟随最近活动的 Agent，也可以固定一家** |
| **能不能扩展** | 每个 App 各做各的 | **公开、很小的 Bridge Protocol，可以继续接新 Harness** |

整个逻辑其实很简单：

```text
你的 Coding Agent  →  Connector  →  Agent 状态  →  Live2D 动作 / 表情 / 状态栏
```

Connector 只负责告诉桌宠：**Agent 正在做什么**。至于这个状态要怎么「演」，
由你的 Live2D 模型和设置决定。

---

## 不切回终端，也知道 Agent 现在卡在哪一步

| Agent 状态 | 你看到的 |
|---|---|
| `空闲` | 闲置动作，偶尔自己看看四周、播个动作 |
| `思考中` | 思考动作与表情（内部仍区分 writing / researching） |
| `执行中` | 正在调用工具 |
| `等待中` | 正在等你输入 |
| `审阅中` | 复核 / 验证 |
| `同步中` | 正在和另一个 Agent 或外部服务打交道 |
| `出错` | 出问题了 |

另外还有两种可以叠加在主状态上的反应：`受阻`（权限被拒）和 `被打断`。

实际使用里，最有价值的往往不是「它正在工作」，而是**它已经停下来等你了**。
跑时间比较长的 Agent 不会再悄悄停在某个终端 Tab 里 —— 你用余光就能知道它还在继续，
还是下一步已经轮到你。

### 想再多看一点？

在 **设置 → 通用 → 状态栏** 打开「显示它具体在做什么」，状态下面会增加一行：
工具自己的简短说明、正在修改的**文件名**、正在访问的**域名**，或当前搜索词。

这一行不会显示命令行，也不会显示文件内容 —— 命令行里可能带着鉴权头。
功能默认关闭；关闭时 Connector 根本不会去读这些细节字段。

---

## 接上你本来就在用的 Agent

Agent Avatar 内置五家 Connector。打开 **设置 → Agent → 接入**，选你使用的 Harness，
点一下**安装**即可。Connector 与 Python 解释器都**随 App 一起分发**，所以不下载任何东西，
App 和它的 Connector 也永远不会版本不一致。App 会调用对方自己的 CLI 完成注册、验证结果，
并告诉你这家 Harness 还要求你做哪一步。

| Harness | 在 Agent Avatar 内安装 | 最后还需要 |
|---|---|---|
| **Claude Code** | ✅ | 新开一个会话 |
| **DeepSeek Harness** | ✅ | 无 —— 热加载 |
| **Hermes** | ✅ | 运行 `hermes plugins enable agent-avatar`，然后重启正在运行的会话 |
| **WorkBuddy** | ✅ | 重启 App |
| **Codex** | ✅ | 完全退出并重开 App，然后在会话里用 `/hooks` 授信一次 |

**最后这一步不是 App 偷懒。** 把插件加载在自己进程里的 Harness，不重启就换不了插件；
Codex 则是**故意**要求由人来授信 hook 代码之后才肯运行。安装器会当场把那句命令或那一步
写给你，而不是留给你一只装完毫无反应的桌宠。

五家的底层没有任何共同点 —— 插件机制不同、事件名不同、生命周期也不同。
每个 Connector 把自己那家翻译成同一套很小的状态契约，所以每接一家新的，桌面这一层都不用改。

### 同时开着几个 Agent？

形象默认跟随最近活动的那一个；也可以从右键菜单固定到某一家。打开状态栏第二行后，
还可以看到**当前到底是哪一家 Agent 在报状态**。

### 用的是别的 Agent？

中间的接入契约刻意做得很小：一个本地状态文件，加上一组固定状态。见
**[Bridge Protocol](bridge/README.md)**。项目里自带的五个 Connector 也可以直接作为
接入其他 Harness 的参考 —— 每一份都不到 65 行。

---

## Agent 你选，形象也由你选

Agent Avatar 不把某个 AI 和某个角色绑死。**Agent 和 Live2D 形象是两件独立的事情。**

**出于版权考虑，我们不内置任何 Live2D 模型。** 不同模型的再分发许可不一样，
所以把角色选择留给用户，而不是默认打包别人的作品。

- **还没有模型？** 首次启动会直接给出
  [Live2D 官方免费示例模型](https://www.live2d.com/zh-CHS/learn/sample/) 的链接，
  下载、解压、拖进 App 即可。
- **已经有喜欢的模型？** 直接用。绝大多数 Cubism 3/4/5 模型不需要专门为 Agent Avatar
  再制作；使用 Cubism 5.1 离屏合成的模型会被识别并提示，而不是错误渲染。
- **想装几个都可以。** 右键菜单里随时切换，不用重启；暂时不用的可以隐藏。
- **模型画廊一次看清。** 尺寸、动作、表情，以及 Agent 状态映射是否有效都会列出来，
  放上桌面前就能先发现问题。
- **第三方命名太乱也没关系。** 如果模型里是 `F1`、`2222333` 这种名字，
  App 会尽量读取作者写过的名称，其余也可以自己改。
- **如果你是模型作者**，并愿意授权 Agent Avatar 随包分发你的作品，欢迎
  [开一个 issue](https://github.com/joyparkray/agent-avatar/issues)。项目里会明确署名和授权方式。

<p align="center">
  <img src="assets/screenshots/desktop-zh.png" width="900" alt="同一个应用换了模型、切到中文界面">
</p>

<p align="center"><em>同一套 Agent 接入层，换一个 Live2D 模型、切成中文界面。</em></p>

---

## 但它首先仍然是一只完整的桌宠

<p align="center">
  <img src="assets/screenshots/connectors-and-menu.png" width="900" alt="设置里五家 connector 全部已连通，旁边是形象的右键菜单">
</p>

Agent 接入是 Agent Avatar 最特别的地方，但没有任务时，它也不是一块只会显示「Idle」的进度条。

- **闲着的时候自己活起来。** 安静一段时间后会自己看看四周、播放动作；
  闲置动作和点击反应用不同的动作池。眼睛跟随鼠标也可以单独开关。
- **单击、双击、全局快捷键都能触发。** 模型里的任何表情或动作都可以绑定；
  同一个触发方式绑多个，就随机挑一个播放。
- **在场，但不挡操作。** 透明悬浮、始终置顶，角色之外的区域自动点击穿透；
  也可以整窗穿透，需要操作时在角色上悬停 3 秒即可恢复。
- **实时口型。** 支持系统音频、本地音频文件和 Hermes 语音流，
  让本来会说话的 Agent 直接用同一个桌面形象开口。
- **占多少资源、多少屏幕都由你定。** 三档渲染质量、30/60 FPS、缩放、透明度，
  以及只显示胸像的聚焦裁切。
- **中英文完整覆盖。** 界面、状态栏、安装引导和错误提示都有中英文。

---

## 安装

### 系统要求

- **macOS 14.2 或更新**，或 **Windows 10 或更新**。
- 一个 Live2D 模型 —— **安装包不内置模型**，见上面的
  [形象说明](#agent-你选形象也由你选)。

两个平台的 Connector 和口型功能都可用。系统音频采集在 macOS 走 Core Audio process tap，
在 Windows 走 WASAPI loopback，最终进入的是同一套 Avatar 事件层。

### 下载

1. 从 [Releases](../../releases) 下载最新版：

   | 平台 | 文件 |
   |---|---|
   | macOS（Apple Silicon） | `Agent.Avatar_<版本>_aarch64.dmg` |
   | Windows（x64） | `Agent.Avatar_<版本>_x64-setup.exe` |

   **macOS：** 打开 `.dmg`，把 `Agent Avatar.app` 拖进「应用程序」。版本已使用 Apple
   Developer ID 签名并通过公证，直接双击即可。目前只发布 Apple Silicon 安装包；
   Intel Mac 可以[从源码构建](CONTRIBUTING.md)。

   **Windows：** 直接运行安装器。这个包**没有代码签名** —— 我没有 Windows 代码签名证书，
   它按年签发、需要付费身份核验，对一个免费的业余项目来说这笔钱暂时不太说得过去。
   所以首次运行时 SmartScreen 会提示警告：选择 **更多信息 → 仍要运行**。
   如果你不想只凭信任就跑一个未签名的程序：GitHub 给每个文件都附了 SHA-256 摘要可供核对，
   也完全支持从源码构建 —— 见 [SECURITY.md](SECURITY.md#sandboxing-and-notarisation)。
   卸载 Agent Avatar 时，也会把五家 Agent 里的 Connector 一并移除。

2. 启动 Agent Avatar。没有模型时，引导卡片会给出 Live2D 官方免费示例模型链接。
3. 安装模型：把模型文件夹拖进 **设置 → 模型**，或者直接拖到「尚未安装模型」的引导卡片上。
   见 [docs/MODELS.md](docs/MODELS.md)。
4. 接入 Agent：打开 **设置 → Agent → 接入**。见 [docs/CONNECTORS.md](docs/CONNECTORS.md)。

也可以[从源码构建](CONTRIBUTING.md)。

---

## 手动安装 Connector

App 内一键安装是推荐路径。下面这条主要留给 Harness 跑在 **WSL、容器、另一台机器**上的情况，
或者你想先把命令看一遍再执行。

先构建 Connector Tree，再用 Harness 自己的 CLI 安装。以 Claude Code 为例：

```bash
sh connectors/build-bundle.sh ./connector-tree
cd connector-tree/marketplace
python localize.py claude-code          # 把解释器绝对路径写进 hook 命令行
claude plugin marketplace add ./
claude plugin install agent-avatar@agent-avatar
```

Claude Code、Codex、WorkBuddy、DeepSeek Harness 和 Hermes 的完整安装命令都在
**[Connector README](connectors/marketplace-README.zh.md)** 里。

| Harness | 手动安装后 |
|---|---|
| Claude Code | 新开一个会话 |
| DeepSeek Harness | 无 —— 热加载 |
| Hermes | `hermes plugins enable agent-avatar`，然后重启正在运行的会话 |
| WorkBuddy | 重启 App |
| Codex | 完全退出并重开 App，然后在会话里用 `/hooks` 授信 |

Codex 的授信按内容哈希记录，因此 Connector 升级后需要重新授信。详情和排查见
[docs/CONNECTORS.md](docs/CONNECTORS.md)。

最后，在形象右键菜单里选择对应的 **Agent State Source**。

---

## 设置

共六页：

- **通用** —— 语言、状态栏以及显示内容
- **视频** —— 缩放、透明度、聚焦裁切、画质、帧率
- **Agent** —— Connector，以及每个 Agent 状态对应的动作
- **行为** —— 闲置自治、触发方式、表情 / 动作别名
- **模型** —— 安装、隐藏、删除
- **关于** —— 版本、更新检查、相关链接

---

## 给开发者

Agent Avatar 分成三层，让 Agent 端和角色端彼此独立：

```text
desktop/      Live2D 渲染、音频口型、窗口与菜单（Tauri + Rust + TypeScript）
bridge/       两边共用的协议与状态机
connectors/   每家 Harness 的适配层与安装脚本
docs/         模型安装、Agent 接入、排查
```

状态机只有一份，位于 `bridge/`。自包含的插件树由 `connectors/assemble.sh` 组装生成，
不靠手工复制。

### 文档

- [快速上手 —— 10 分钟、无需 clone 源码](docs/QUICKSTART.zh.md)
- [模型 —— 安装、要求、什么不支持](docs/MODELS.md)
- [接入 —— 各家 Harness 的设置与坑](docs/CONNECTORS.md)
- [排查](docs/TROUBLESHOOTING.md)
- [Bridge Protocol —— 想接新 Harness 就看这里](bridge/README.md)
- [架构 —— 三层怎么拼起来](ARCHITECTURE.md)
- [参与开发 —— 构建与测试](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)

---

## 支持我们

Agent Avatar 免费、开源，也是利用业余时间做的。如果它让你的桌面多了点生气、
你愿意支持这个项目：

| 微信 | 支付宝 |
|---|---|
| <img src="assets/donate-weixin.png" width="200" alt="微信收款码"> | <img src="assets/donate-alipay.png" width="200" alt="支付宝收款码"> |

海外也可以使用 [Buy Me a Coffee](https://buymeacoffee.com/joyparkray) 或 [PayPal](https://www.paypal.com/donate/?business=KP5WLPJ9TJBZL&no_recurring=0&currency_code=USD)。

另外，提 [issue](https://github.com/joyparkray/agent-avatar/issues)、发
[PR](https://github.com/joyparkray/agent-avatar/pulls)、或者给项目点一颗 Star，
也都是支持。谢谢使用。❤️

## 许可

MIT，见 [LICENSE](LICENSE)。

Live2D Cubism Core 按 Live2D 自己的专有许可再分发，并且**安装包不包含任何 Live2D 模型**。
见 [THIRD-PARTY.md](THIRD-PARTY.md)。
