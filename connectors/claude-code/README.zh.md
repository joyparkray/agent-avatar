# Claude Code 接入指南

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

> 让 Agent Avatar 随 Claude Code 的思考 / 跑工具 / 派子代理变表情。
> **WorkBuddy 复用同一份 hook**（见 §5）。

事件形状取自实机抓取（**Claude Code 2.1.212**，macOS，隔离 `--settings` 取样器），
不是照文档猜的。

---

## 1. 安装

**app 会替你装**：设置 → Agent → 接入 → 安装。插件与 Python 解释器都随 app 分发，
由 app 调用 `claude` 完成注册；失败时会把 CLI 说的话原样报出来。

手动装 —— 给 app 够不着的 Claude Code（WSL、容器、另一台机器），或者你想先读命令：

```bash
sh connectors/build-bundle.sh ./connector-tree
cd connector-tree/marketplace
python localize.py claude-code
claude plugin marketplace add ./
claude plugin install agent-avatar@agent-avatar
```

装完**开一个新会话** —— 插件在会话启动时加载。完整说明（含另外四家）见
[连接器 README](../marketplace-README.zh.md)。

> `localize.py` 把「正在跑它的那个解释器」的绝对路径写进 hook 命令行。
> **Windows 上不是可选项**：那里的 `python3` 不是 Python，而是一个 0 字节的应用商店存根 ——
> 能启动、打印「Python was not found」、以 9009 退出。9009 不是 2，所以没有任何 harness
> 会把它当成失败，唯一的表现就是形象一直不动。macOS 上也建议跑：它会把解释器钉死，
> 而不是留着 `/usr/bin/python3` —— 在没装 Xcode 命令行工具的 Mac 上，那个同样是个
> 会弹安装框的占位符。

产物天然**自包含**：hook 脚本 + Bridge 的两个模块。状态机的单一真相留在 `../../bridge/`，
构建时拷进去，不是手抄。

开发期也可以不装，直接加载（改完 `/reload-plugins` 即可）：

```bash
claude --plugin-dir <tree>/plugins/claude-code/agent-avatar
```

装好后 `claude plugin details agent-avatar@agent-avatar` 应显示：

```
Hooks (10)  SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
            PostToolUseFailure, PermissionDenied, SubagentStart, SubagentStop, Stop
            (harness-only — no model context cost)
Projected token cost
  Always-on:   ~0 tok   added to every session
```

**零上下文开销**是纯观察者设计的直接回报 —— Claude Code 认出这是 harness 层的东西，
不往对话里塞任何内容。

### 布局（与 Codex 相反，别搞混）

```
agent-avatar/
├── .claude-plugin/plugin.json   ← 只有 manifest 能放这里
└── hooks/hooks.json             ← hooks 在 **hooks/ 子目录**
```

⚠️ Codex 要求 `hooks.json` 在**插件根目录**，Claude Code 要求在 **`hooks/` 子目录**里，
而且 CC 官方明确警告：除 `plugin.json` 外任何目录都**不能**放进 `.claude-plugin/`。

路径变量是 **`${CLAUDE_PLUGIN_ROOT}`**（Codex 是 `${PLUGIN_ROOT}`），照官方 `hookify`
插件的惯例带引号写：`python3 "${CLAUDE_PLUGIN_ROOT}/hooks/agent-avatar-hook.py" ; exit 0`。

### 不需要额外的 hook 授信

Claude Code **没有** Codex 那种逐条 hook 审阅。官方安全模型是：

> "Plugins and marketplaces are highly trusted components that can execute arbitrary code
> on your machine with your user privileges. Only install plugins and add marketplaces
> from sources you trust."

**安装即信任。** 审阅发生在安装前 —— `/plugin` 详情页的 "Will install" 区块会列出
这个插件会装哪些 hooks / agents / MCP。

### 备用：手工写进 settings.json

不走插件的话，也可以把 hooks 直接写进 `~/.claude/settings.json`（格式与
`hooks/hooks.json` 里的 `hooks` 对象相同）。**但要自己写绝对路径**，于是要自己承担 §2
那个风险，并且**务必加 `; exit 0`**。插件路径没有这个问题。

## 2. 🔴 装之前必须知道的一件事

**Claude Code 把退出码 2 当作 block**，且**本脚本挂掉的后果按事件不同**：

| 事件 | exit 2 的后果 |
|:--|:--|
| `PreToolUse` | **拦掉工具调用** |
| `Stop` | **阻止停止 —— 对话停不下来** |
| `SubagentStop` | 阻止子代理结束 |
| `UserPromptSubmit` | 拒掉你的提示词 |
| `PostToolUse` / `PostToolUseFailure` / `SessionStart` / `SessionEnd` / `SubagentStart` / `PermissionDenied` | 忽略（安全） |

脚本自身永远 `exit 0`（任何异常都被吞掉）。**危险的是脚本根本没跑起来**：
`python3 <不存在的文件>` 的退出码**恰好是 2**。所以

> **路径写错 / 移动了 checkout / 换了 Python** = 你的工具被拦、对话停不下来。

这在 Hermes 上已经真实发生过一次（2026-08-28）。**移动或重命名脚本前，先撤注册。**

**我们刻意不注册**这些事件：`PermissionRequest`（阻塞式决策 hook；没响应时 CC 会直接
拒绝工具调用而不是回落到确认框，见 [anthropics/claude-code#46193](https://github.com/anthropics/claude-code/issues/46193)）、
`WorktreeCreate`（要求往 stdout 打印路径，被动 hook 会让 `claude -w` 报
"no successful output"）、`PreCompact` 及其余可阻塞事件。
**表情系统绝不进决策链路。**

---

## 3. 事件映射

| Claude Code | 内部事件 | 说明 |
|:--|:--|:--|
| `SessionStart(source=startup\|clear)` | `on_session_start` | 只有这两个是「开新局」 |
| `SessionStart(source=resume\|compact\|fork)` | *忽略* | 同一局的延续，重置会清掉活着的子代理 |
| `UserPromptSubmit` | `pre_llm_call` | |
| `PreToolUse` | `pre_tool_call` | |
| `PostToolUse` | `post_tool_call` | |
| `PostToolUseFailure` | `post_tool_call` + `status=error` | 比 Hermes 从 status 反推更明确 |
| `PermissionDenied` | `post_tool_call` + `status=blocked` | 触发 blocked 叠加反应 |
| `SubagentStart` / `SubagentStop` | `subagent_start` / `subagent_stop` | `agent_id` → `child_session_id` |
| `Stop`（`stop_hook_active` 为真时忽略） | `post_llm_call` | 不清子代理：后台子代理会活过 Stop |
| `SessionEnd` | `on_session_finalize` | |

**字段对应**：`prompt_id` → `turn_id`、`tool_use_id` → 工具配对键、`agent_id` → 子代理 ID。

---

## 4. 三处和 Hermes 不一样的地方（实测）

1. **子代理事件带的是父会话的 `session_id`**，靠 `agent_id` 区分。
   Hermes 是子代理有自己的 session_id，需要一份「忽略名单」——**CC 不需要那套**。
   规则：带 `agent_id` 的事件一律不驱动形象，`SubagentStart/Stop` 除外（那是父会话的记账）。
2. **孤儿 `SubagentStop`**：`/compact` 会发一条 ID 从没出现过的 stop。
   CC 用 `ignore`（只处理配得上的），Hermes 用 `dequeue-oldest`——**两家要求相反**，
   所以这条是 `bridge/state_machine.py` 里唯一参数化的策略。
3. **`prompt_id` 就是 turn id**：实测同一轮从 `UserPromptSubmit` 到 `Stop` 全程不变，
   下一轮换新值，`session_id` 不变。所以 Hermes 那套 turn 记账原样复用，
   工具收尾后不会掉回 idle。

**已知未实现**：`SubagentStop` 被别的 hook block 时同一个子代理会复活
（官方：exit 2 on `SubagentStop` 阻止停止）。我们会短暂少算一个 `awaiting`，
直到真正的 stop 到达。只在别的 hook 主动 block 时发生，未做处理。

---

## 5. WorkBuddy 复用这份 hook

WorkBuddy 的 agent core 是 CodeBuddy Code —— Claude Code 的形状：一样的 `hook_event_name`
stdin 契约、一样的 `hooks/hooks.json` 插件布局，连 `${CLAUDE_PLUGIN_ROOT}` 都会被设置。
所以**本目录的脚本原样复用**，只是配置目录不同（app 读 `~/.workbuddy`，独立 CLI 读
`~/.codebuddy`）。装法与那两个 home 的坑见 [`../workbuddy/README.zh.md`](../workbuddy/README.zh.md)。

WorkBuddy 没有 `PostToolUseFailure` 之外的能力差异；少发的事件不影响 ——
映射表里查不到就忽略。

> **DeepSeek Harness 不在此列（早期判断有误）。** 设计稿曾写「dsh 自带 Claude Code 的
> hook bridge，可以零改动复用本页的注册」，2026-08-28 实机推翻：那台机器上的
> dsh 0.1.1-rc.2 没有任何 hook 桥接包，它的扩展点是 **cordis 事件**，事件名、载荷、
> 注册方式与 CC 全不同。dsh 因此有自己的翻译层与 in-process 插件，
> 见 [`../dsh/README.zh.md`](../dsh/README.zh.md)。

---

## 6. 自测

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt_id":"t1"}' | \
  /usr/bin/python3 /path/to/agent-avatar/connectors/claude-code/agent-avatar-hook.py
cat "$TMPDIR/agent-avatar-state.json"     # 应见 state: writing
```

不碰自己的 `~/.claude/settings.json` 做整链路验证（推荐）：把上面 §1 那段写成一个独立文件，
然后 `claude -p --settings <那个文件> '...'`。这正是本适配层的事件基线的取得方式。
