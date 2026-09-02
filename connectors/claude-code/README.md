# Claude Code 接入指南

> 让 Agent Avatar 随 Claude Code 的思考 / 跑工具 / 派子代理变表情。
> **DeepSeek Harness 与 WorkBuddy 复用同一份 hook**（见 §5）。

事件形状取自实机抓取（**Claude Code 2.1.212**，macOS，隔离 `--settings` 取样器），
不是照文档猜的。

---

## 1. 安装（插件）

```bash
connectors/claude-code/install-plugin.sh
```

> **Windows** 用 `install-plugin.ps1`（PowerShell，与 `.sh` 同义）：
> ```powershell
> powershell -ExecutionPolicy Bypass -File connectors\claude-code\install-plugin.ps1
> ```
> 它比 `.sh` 版多做一件事：**把解释器换成本机实测可用的绝对路径**。
> Windows 上 `python3` 解析到一个 0 字节的应用商店存根 —— 能启动、打印
> 「Python was not found」、以 9009 退出，而 9009 不是 2，所以**不会被拦下，
> 只会安静地什么都不发生**。详见 `private/WINDOWS-PORT.md` 的「WP4」几节。

脚本把插件组装到 `~/.claude/plugins/local/agent-avatar/`（**必须自包含**：hook 脚本 +
Bridge 的两个模块；状态机的单一真相在 `../../bridge/`，不在 connector 里放副本）。然后：

```bash
claude plugin marketplace add ~/.claude/plugins/local
claude plugin install agent-avatar@agent-avatar-local
```

开发期也可以不装，直接加载（改完 `/reload-plugins` 即可）：

```bash
claude --plugin-dir ~/.claude/plugins/local/agent-avatar
```

装好后 `claude plugin details agent-avatar@agent-avatar-local` 应显示：

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

## 5. DeepSeek Harness / WorkBuddy

两家都用 Claude Code 兼容的 hook 格式与 stdin 形状，**直接复用本目录的脚本**，
只是配置文件位置不同：

### WorkBuddy

有自己的配置文件与入口脚本，见 `../workbuddy/README.md`。

### DeepSeek Harness —— **不需要任何额外配置**

dsh 自带 Claude Code 与 Codex 的 hook bridge：

> "DeepSeek Harness ships hook bridges for Claude Code and Codex that **run your existing
> hooks.json**... `dsh-hooks-claude-code` executes your existing `.claude/hooks.json`."

也就是说，**你在本页 §1 注册的那一份，dsh 会直接执行**。装了 dsh 的 hook bridge 之后，
Echo 就跟着 dsh 一起动，我们这边零改动。

两条限制：

1. **走 bridge 时 dsh 与 Claude Code 无法区分** —— 事件从同一份配置来、写进同一个
   `agent-avatar-state.claude-code.json`，`detail` 也会显示 "Claude Code"。
   想分开就得让 dsh 走它自己的插件/stdio 模式单独注册，那需要实机验证，尚未做。
2. **未实机验证**：本机没装 dsh。bridge 的存在有厂商文档背书，但它转发的 stdin 是否
   保留了 `session_id` / `tool_use_id` / `prompt_id` 的 CC 形状**没有验证过** ——
   丢了 `prompt_id` 的话 turn 记账会空，表现为工具之间闪 idle。

**能力更少，按实际支持的事件裁剪注册清单**：两家都没有子代理事件
（去掉 `SubagentStart` / `SubagentStop`），WorkBuddy 没有 `PostToolUseFailure`。
少发的事件不影响——映射表里查不到就忽略。

---

## 6. 自测

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt_id":"t1"}' | \
  /usr/bin/python3 /path/to/agent-avatar/connectors/claude-code/agent-avatar-hook.py
cat "$TMPDIR/agent-avatar-state.json"     # 应见 state: writing
```

不碰自己的 `~/.claude/settings.json` 做整链路验证（推荐）：把上面 §1 那段写成一个独立文件，
然后 `claude -p --settings <那个文件> '...'`。这正是本适配层的事件基线的取得方式。
