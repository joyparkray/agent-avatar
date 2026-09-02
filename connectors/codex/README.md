# Codex 接入指南

> Codex app（desktop）是**唯一两条链路都能接**的 harness：语义状态（本文）**和**语音口型
> （ChatGPT Voice → 系统音频 → 皮肤的 `global` 音源，见 §4）。

契约来源：[Codex Hooks 官方文档](https://learn.chatgpt.com/docs/hooks)。

---

## 0. ChatGPT app 里的 ChatGPT 和 Codex 是两回事

Codex 已经并进 ChatGPT app（`codex app` 就是拉起它）。同一个 app 里两个面，能接的东西不同：

| ChatGPT app 里的面 | 出声（嘴型，P0） | 语义状态（表情） |
|:--|:--|:--|
| **Codex**（写代码那个 agent） | ✅ 系统音频 | ✅ lifecycle hooks |
| **ChatGPT 聊天 / 语音模式** | ✅ 系统音频 | ❌ **没有 lifecycle hooks** |

官方原话：*"When your plugin is enabled, **Codex** can load lifecycle hooks from your plugin."*
—— hooks 跑在 **Codex 的 agent 循环**里，普通 ChatGPT 对话没有这套事件。
聊天那边的扩展点是 skills / connectors / MCP / apps，都是「让模型能调什么」，
不是「她现在在干什么」的推送信号。

**所以 ChatGPT 聊天侧我们能接的只有嘴，接不了表情** —— 而嘴那条**不需要任何对接**：
语音模式从系统音频出声，皮肤的 `global` 音源直接就能捕到（见 §4）。

---

## 1. 安装（推荐：Codex 插件）

```bash
connectors/codex/install-plugin.sh
```

> **Windows** 用 `install-plugin.ps1`（PowerShell，与 `.sh` 同义）：
> ```powershell
> powershell -ExecutionPolicy Bypass -File connectors\codex\install-plugin.ps1
> ```
> 它比 `.sh` 版多做一件事：**把解释器换成本机实测可用的绝对路径**。
> Windows 上 `python3` 解析到一个 0 字节的应用商店存根 —— 能启动、打印
> 「Python was not found」、以 9009 退出，而 9009 不是 2，所以**不会被拦下，
> 只会安静地什么都不发生**。详见 `private/WINDOWS-PORT.md` 的「WP4」几节。
> Codex 有 `commandWindows` 这个 Windows 专用命令覆盖字段，所以 POSIX 那条
> `/usr/bin/python3` **原样保留**，两个平台共用同一份 hooks.json。

然后：**重启 ChatGPT app** → 在 **Plugins 标签页启用 Agent Avatar** → **审阅并信任它的 hooks**。

> 🔴 **第 3 步的入口是 `/hooks`，不在 Plugins 页面上。**
> 插件装好并启用之后，hooks 仍然是**未信任**状态，会被**静默跳过** —— 没有报错、
> 没有提示，表现就是「插件明明是启用的，但形象不动」。2026-08-28 实测确认：
> 插件 `installed, enabled` 时跑一轮 Codex，状态文件根本不生成；
> 同一条命令加上 `--dangerously-bypass-hook-trust` 就立刻写出来了。
>
> **在 Codex 会话里输入 `/hooks`**，审阅并信任 Agent Avatar 的 hooks。官方：
> *"Use `/hooks` in the CLI to inspect hook sources, review new or changed hooks, trust hooks…"*，
> 且 *"If hooks need review at startup, Codex prints a warning that tells you to open `/hooks`."*
>
> ⚠️ **信任按 hook 内容的哈希记账**：*"Codex records trust against the hook's current hash,
> so new or changed hooks are marked for review and skipped until trusted."*
> —— **每次升级插件（`hooks.json` 变了）都要重新在 `/hooks` 里信任一次**，
> 否则升级完就悄悄失效。这是本集成最容易踩的运维坑。
>
> 自动化场景可以用 `--dangerously-bypass-hook-trust` 绕过（只对单次调用生效）。
> **不要**把它写进日常使用的命令里 —— 它绕过的是一道针对「hook 会执行任意代码」的真实防线。

脚本做三件事：把插件文件装进 `~/.codex/plugins/agent-avatar/`、在
`~/.agents/plugins/marketplace.json` 登记一条本地 marketplace 条目（已有文件先备份成
`.bak-agent-avatar`，其它条目保留）、然后 `codex plugin add agent-avatar@local`。

> 🔴 **注册路径必须是相对于 marketplace root 的 `./` 路径。**
> root = 含 `.agents/` 的那一层（`~/.agents/plugins/marketplace.json` → root 是 `~`），
> 所以插件在 `~/.codex/plugins/agent-avatar` 时要写 `"path": "./.codex/plugins/agent-avatar"`。
> 官方：*"Codex resolves `source.path` relative to the marketplace root"*，且必须留在 root 内。
>
> **给绝对路径会被静默丢弃** —— 不报错，插件在 `codex plugin list` 里根本不出现，
> app 的 Plugins 标签页里也看不到。我们第一版就是这么写的，2026-08-28 实测撞到。
>
> 排查用 `codex plugin list`（不用开 app）：
> - 完全没有这一行 → marketplace 路径写错了（多半用了绝对路径）
> - `not installed` → 登记到了但没装，跑 `codex plugin add agent-avatar@local`
> - `installed, enabled` → 插件到位了。**形象仍然不动的话就是 hooks 没信任** ——
>   在 Codex 会话里 `/hooks`。验证办法：跑一轮对话后看
>   `$TMPDIR/agent-avatar-state.codex.json` 有没有生成。

**为什么用插件而不是手改 `hooks.json`**：

1. **用户在 app 里就能开关**，不用碰配置文件；
2. hook 命令用 **`${PLUGIN_ROOT}`** 定位 —— 路径不会因为仓库被移动而失效。
   这一点很关键，见 §2；
3. 插件同时被 ChatGPT app 与 Codex CLI 发现（统一插件目录）。

卸载：`codex plugin remove agent-avatar`，再删掉 `~/.codex/plugins/agent-avatar`。

### 备用：直接写 hooks.json

不想走插件的话，Codex 也认 `~/.codex/hooks.json` / `<repo>/.codex/hooks.json`
（项目级很适合做隔离测试）。事件与插件里那份一致，但**命令必须自己写死绝对路径**，
于是要自己承担 §2 那个风险，并且**务必加 `; exit 0`**。

## 1.5 插件的目录布局（两个发现机制并存，不是冗余）

```
agent-avatar/
├── .codex-plugin/plugin.json   ← 含顶层 "hooks": "./hooks.json"
├── hooks.json                  ← **必须在根目录**
└── scripts/agent-avatar-hook.py   （+ state_machine.py、pascal_events.py）
```

**两处都要有，因为 CLI 与 app 的发现方式不同**（2026-08-28 实测）：

| | codex-cli 0.144.4 | ChatGPT app |
|:--|:--|:--|
| `plugin.json` 顶层 `hooks` 字段 | ✅ 认 | ❌ 不认 |
| 根目录 `hooks.json` | ❌ 不认 | ✅ 认 |

实测记录：只留字段 → CLI 触发、app 不触发；只留根文件 → **CLI 完全不触发**
（两次验证：相对路径与 `${PLUGIN_ROOT}` 都不触发，排除了路径解析的可能）；
两者并存 → CLI 恢复触发。字段指向同一个 `./hooks.json`，不会重复注册。

根目录布局是官方目录里 Figma / Replay.io 的实际约定 —— 但注意**它们在本机是
`not installed` 状态**，只是目录条目，所以它们能证明打包约定，不能证明 CLI 的加载行为。

> 顺带澄清一个容易误判的现象：如果 validator 真的**拒绝**了顶层 `hooks` 字段，
> 插件卡片不会显示「已安装、已启用」。卡片正常显示说明清单被接受了 ——
> app 只是不从那个字段发现 hooks，不是拒绝整个清单。

`interface` 还必须带 `capabilities` 与 `defaultPrompt`（照 Figma 的形状），否则通不过校验。
我们声明 `"capabilities": ["Read"]` —— 纯观察者，不写、不交互。

## 2. 🔴 退出码 2 会拦死工具

Codex 把**退出码 2 当作 block**，范围比 Claude Code 还大：
`PreToolUse`（拒工具）、**`PostToolUse`（也会 block —— CC 在这个事件上是忽略的）**、
`PermissionRequest`、`UserPromptSubmit`、`Stop` / `SubagentStop`。

脚本自身永远 `exit 0`。**危险的是脚本没跑起来**：`python3 <不存在的文件>` 的退出码**恰好是 2**。
实测对照（在 Claude Code 上做的，Codex 同理）：

| 注册写法 | 路径失效时 |
|:--|:--|
| `python3 /bad/path.py` | **工具被拦死** |
| `python3 /bad/path.py ; exit 0` | 工具正常执行 |

同类事故在 Hermes 上真实发生过一次（2026-08-28，脚本移动后进程未重启）。
**插件路径天然规避了它**：`${PLUGIN_ROOT}` 由 Codex 解析，插件在哪它就指哪。
即便如此，插件里的命令仍然带了 `; exit 0` —— 双保险。

**我们刻意不注册** `PermissionRequest`：它是阻塞式决策 hook，表情系统绝不进权限决策链路。
Codex 没有 Claude Code 那种被动的 `PermissionDenied`，所以 Codex 上**没有 blocked 反应**——
可接受的功能缺失，不值得用一个能拦工具的 hook 去换。

## 2.5 在 `/hooks` 里认出我们的 hook

列表页的 Description 列显示的是 **Codex 自己的通用事件说明**（"Before a tool executes"），
不是插件的 —— 光看列表分不出哪几条是谁装的。

**按 `enter` 下钻**，详情页会给出来源：

```
Event      PreToolUse
Matcher    *
Source     Plugin — agent-avatar@local        ← 这一行就是标识
Command    /usr/bin/python3 …/agent-avatar/1.0.0/scripts/agent-avatar-hook.py ; exit 0
Timeout    600s
Trust      Modified since last trusted — review required
```

`Source` 与 `Command` 里的 `agent-avatar` 都能认出来，**Codex 本身已经解决了识别问题**，
只是要下钻一层。

> **我们刻意不写 `statusMessage`。** 它是单条 hook 上唯一的自定义文本字段，
> 但**它不出现在审阅页面**（那里只有上面六行），所以对识别没有帮助；
> 而它是 hook **执行时**的状态行 —— 我们在每一次工具调用上都触发，
> 写了就等于每调一次工具闪一行字。纯观察者应该是隐形的，而且我们的 hook 是
> 亚毫秒级的，也不存在「让用户知道在等什么」的需求。
> （2026-08-28 一度加过，发现它既不解决识别、又白白让已有的信任失效，随即撤回。）

> ⚠️ **任何对 `hooks.json` 的改动都会让信任失效** —— 信任按 hook 内容的哈希记账，
> 详情页会显示 `Modified since last trusted`。升级插件后务必重新 `/hooks` 授信。

### 观察：这一版的 `/hooks` 不列 `SessionEnd`

实测（codex-cli 0.144.4 + ChatGPT app，2026-08-28）：我们声明了 8 个事件，
`/hooks` 只列出 7 条待审（`PreToolUse` / `PostToolUse` / `SessionStart` /
`UserPromptSubmit` / `SubagentStart` / `SubagentStop` / `Stop`），
**`SessionEnd` 在事件表里根本没出现**——尽管官方文档说它是支持的事件。

后果：Codex 上 `on_session_finalize` 可能永远不触发，会话记录不会被清理。
**不致命**：`Stop` 会把回合收尾成 `idle`，皮肤侧还有 300s 的过期兜底。
声明保留着，等哪个版本开始发就自动生效。

---

## 3. 和 Claude Code 的三处差异

翻译层是共用的（`../../bridge/pascal_events.py`），Codex 与 CC 只差三点：

| | Claude Code | Codex |
|:--|:--|:--|
| 回合字段 | `prompt_id` | **`turn_id`**（官方：turn-scoped hooks 都带） |
| 工具失败 | 独立事件 `PostToolUseFailure` | **无** —— 从 `tool_response` 反推（`exit_code` / `error` / `is_error`） |
| 被拒信号 | 被动的 `PermissionDenied` | **无**（只有阻塞式 `PermissionRequest`，不注册） |
| `SessionStart.source` | `startup\|resume\|clear\|compact\|fork` | 同上但**没有 `fork`** |

其余一致：`session_id` / `tool_use_id` / `agent_id` 字段名相同，注册结构相同，
子代理事件都有（**设计稿早期写「Codex 没有子代理事件」是错的**）。

## 4. 语音口型：不需要任何对接

Codex app 的 ChatGPT Voice **从系统音频出声**，皮肤的 `global` 音源直接就能捕到 ——
**没有一行 Codex 专用的音频代码**。在皮肤右键菜单里把音源切到「全局」即可，
首次切换时系统会弹一次录音授权，点允许就行（走的是 Core Audio process tap，
**不需要屏幕录制权限**，也不用去系统设置里开）。

这条链路是 Codex 相对其它 harness 的关键优势：Claude Code 只有语义状态不出声，
Claude Desktop 的 Chat tab 只出声没有状态，**只有 Codex app 两样都有**。

## 5. 自测

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"s1","turn_id":"t1"}' | \
  /usr/bin/python3 /path/to/agent-avatar/connectors/codex/agent-avatar-hook.py
cat "$TMPDIR/agent-avatar-state.json"     # 应见 state: writing、detail 以 "Codex" 开头
```

**未实机验证**：本机只有 codex-cli 0.144.4，没装 Codex.app。事件形状按官方文档实现，
**装了 desktop 之后要按 Claude Code 那套方法实抓一轮复核**
（见 `docs/DESIGN-M3-MULTI-HARNESS.md` §2.6 的取样器做法）。
