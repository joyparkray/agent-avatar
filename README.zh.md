# Agent Avatar

一个住在桌面上的 Live2D 形象，**把你的 AI 编程 agent 正在干什么演出来** —— 思考、执行命令、
等你回话、出错 —— 并在 agent 出声时跟着动嘴。

目前支持五家 agent harness：**Claude Code、Codex、Hermes、DeepSeek Harness、WorkBuddy**。

> English: [README.md](README.md)

---

## 它到底做什么

harness 只发布**她现在在干什么**，形象层自己决定**怎么演**。两边通过一份很小的契约通信 ——
[Bridge Protocol](bridge/README.md) —— 之后互不知道对方存在。

| Agent 状态 | 你看到的 |
|---|---|
| `空闲` | 闲置动作，偶尔自己看看四周、播个动作 |
| `思考中` | 思考的动作与表情（内部仍区分 writing / researching） |
| `执行中` | 正在跑工具 |
| `等待中` | 在等你输入 |
| `审阅中` | 复核 / 验证 |
| `同步中` | 在和另一个 agent 或外部服务打交道 |
| `出错` | 出问题了 |

之上还叠两种反应：`受阻`（权限被拒）和`被打断`。

其它：

- **口型同步**：系统音频、本地音频文件、或 Hermes 的语音流 —— 任何会出声的 agent 都能对上嘴。
- **单击**随机换表情，**双击**随机播动作，名单由你勾选。
- **闲置自治**：静置到设定时长后自己看四周、播动作，你一互动立刻让位。
- **眼睛跟随鼠标**（可关），鼠标移出窗口也跟。
- **点击穿透**：常驻屏幕又完全不挡事，想操作时在人物上悬停 3 秒即可恢复。
- 窗口置顶、吸附底边、聚焦裁切、缩放、透明度、画质与帧率。
- 中英双语界面。

---

## 系统要求

- **macOS 14.2 或更新**（系统音频捕获走 Core Audio process tap）。
- 一个 Live2D 模型 —— **不随包分发**，见下。
- 暂不支持 Windows。

## 安装

1. 从 [Releases](../../releases) 下载 `Agent Avatar.app`，拖进「应用程序」。目前尚未公证，
   首次打开需要**右键 → 打开**。
2. 启动。没装模型时会看到引导卡片，附 Live2D 官方免费模型的链接。
3. 装模型 —— 把模型文件夹拖进**设置 → 模型**，或放进卡片给你打开的模型目录。
   详见 [docs/MODELS.md](docs/MODELS.md)。
4. 接上你的 agent —— 见 [docs/CONNECTORS.md](docs/CONNECTORS.md)。

也可以[从源码构建](CONTRIBUTING.md)。

## 接上你的 agent

每个 connector 是对应 harness 的一个插件，把 agent 状态报给形象。安装只要跑一个脚本，
但**装完之后各家还要做的事不一样** —— 漏掉这一步是「装了没反应」最常见的原因：

| Harness | 安装 | 装完之后 |
|---|---|---|
| Claude Code | `connectors/claude-code/install-plugin.sh` | 无 |
| DeepSeek Harness | `connectors/dsh/install-plugin.sh` | 无（热加载） |
| Hermes | `connectors/hermes/install-plugin.sh` | `plugins enable agent-avatar` |
| WorkBuddy | `connectors/workbuddy/install-plugin.sh` | **重启 app** |
| Codex | `connectors/codex/install-plugin.sh` | **在会话里用 `/hooks` 逐条授信** |

Codex 那条最容易被当成 bug：插件显示已安装已启用，hook 却被静默跳过；而且授信按**内容哈希**
记账，connector 每次升级都要重新授信。详见 [docs/CONNECTORS.md](docs/CONNECTORS.md)。

然后在形象的右键菜单里选对应的**状态来源**。

---

## 右键菜单

模型 · 动作 · 表情 · 声音来源 · 状态来源 · 窗口置顶 · 吸附底边 · 聚焦模式 ·
眼睛跟随鼠标 · 点击穿透 · 回到屏幕中央 · 设置… · 退出

**设置**分五页：通用（语言、状态栏）、视频（缩放、透明度、聚焦裁切、画质、帧率）、
Agent（把每个状态映射到你这个模型的某个动作）、行为（闲置自治与随机名单）、
模型（安装、隐藏、删除）。

---

## 目录结构

```
desktop/      macOS 应用：Live2D 渲染、音频口型、窗口与菜单（Tauri + Rust + TypeScript）
bridge/       两边共用的协议与状态机 —— 真正可被别人拿走的部分
connectors/   五家 harness 各自的适配层与安装脚本
docs/         模型安装、接入、排查
```

状态机只有一份真相（在 `bridge/`）；自包含的插件树由 `connectors/assemble.sh` **组装**产出，
不是手抄。

## 文档

- [模型 —— 安装、要求、什么不支持](docs/MODELS.md)
- [接入 —— 各家的设置与坑](docs/CONNECTORS.md)
- [排查](docs/TROUBLESHOOTING.md)
- [Bridge Protocol —— 想接新 harness 就看这份契约](bridge/README.md)
- [架构 —— 三层怎么拼起来的](ARCHITECTURE.md)
- [参与开发 —— 构建与测试](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)

## 许可

MIT，见 [LICENSE](LICENSE)。

Live2D Cubism Core 按 Live2D 自己的专有许可再分发，且**不随包分发任何 Live2D 模型**。
见 [THIRD-PARTY.md](THIRD-PARTY.md)。
