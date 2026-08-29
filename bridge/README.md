# Agent Avatar Bridge Protocol

> **一句话**：harness 只发布「她现在在干什么」，形象层自己决定怎么演。
> 两端各实现一次，之后互不知道对方存在。

本文是 Agent Avatar 的**可复用资产**。Live2D 形象是看得见的结果，
真正能被别人拿走的是这套「agent 状态 → 形象行为」之间的契约与那台聚合状态机。

状态：**v1，5 家 harness 全部实机跑通**
（Hermes / Claude Code / Codex / DeepSeek Harness / WorkBuddy）。
轨迹一致：`idle → writing → executing → writing → idle`。

---

## 1. 分层

```
LLM
 │
 ▼
Agent Harness            Hermes / Claude Code / Codex / WorkBuddy / …
 │
 ▼
Harness Adapter          事件名翻译，每家 ~40 行
 │
 ▼
State Machine  ★         聚合成互斥基态 —— **本协议真正的资产**
 │
 ▼
Wire Format              状态文件（见 §4）
 │
 ▼
Avatar Runtime           基态 → 动作/表情，按角色各自决定
 ├── Live2D（今天）
 └── VRM / 3D / 像素 / 纯状态条（以后）
```

**★ 为什么状态机是资产，而不是事件名。**

把 `tool.start` / `tool.end` 定义成标准很容易，难的是把一串乱序、会漏发、跨会话交织的
事件**聚合成一个当前状态**。这些坑我们是靠实机抓包一个个撞出来的，不是想出来的：

- Claude Code 的子代理事件带的是**父会话的 `session_id`**，靠 `agent_id` 区分。
  不过滤的话，子代理的一个工具报错会把形象顶成 `error`，而父会话好好的。
- `/compact` 会发一条 ID 从没出现过、也没有对应 start 的**孤儿 `SubagentStop`**。
  Hermes 要求「配不上就出队最老的」，Claude Code 要求「配不上就 no-op」——**两家相反**。
- 会话被杀时，最后写下的忙态会**永远留在文件里**，需要过期兜底。
- 一个回合里并发多个工具时，要按优先级仲裁显示哪一个。
- 回合字段各家不同：Claude Code 是 `prompt_id`，Codex 是 `turn_id`，Hermes 是 `turn_id`，
  **WorkBuddy 一个都没有**（回落 `session_id`）。拿错或拿不到的后果是 turn 记账全空、
  工具之间形象闪 `idle`。
- **`SessionStart` 不保证在最前**：WorkBuddy 实测是 `UserPromptSubmit → SessionStart`。
  照 CC 的直觉把它当重置，会清掉刚开的回合，整轮没有 `executing`。

**接入方要拿走的是 `bridge/state_machine.py`（stdlib only），
而不是一张事件名表。** 事件名只是它的输入格式。

> 顺带澄清一个容易混的说法：**「插件」是分发形态，「hook」是机制**，不是两条路。
> 五家全都是 hook；我们把五家都打包成插件（用户用各自的插件界面开关），
> 而回调跑在哪各不相同 —— 见 §7.5。

---

## 2. 内部事件词表

适配层把自家事件翻译成这 10 个内部事件。词表沿用 Hermes 的命名（历史原因，不是依赖）。

| 内部事件 | 语义 |
|:--|:--|
| `on_session_start` | 开新的一局（**不是**恢复/压缩/fork） |
| `on_session_finalize` | 会话结束，清理该会话 |
| `on_session_reset` | 会话重置 |
| `pre_llm_call` | 回合开始（用户提交了输入） |
| `post_llm_call` | 回合结束 |
| `pre_tool_call` | 工具开始 |
| `post_tool_call` | 工具结束（可带 `status` / `result` 表达失败或被拒） |
| `subagent_start` | 派出子代理 |
| `subagent_stop` | 子代理结束 |

**公共字段**：`session_id`（归属会话）、`turn_id`（回合，用于记账）、
`tool_name`、`tool_use_id`（工具配对键）、`tool_input`、
`child_session_id`（子代理身份）、`status` / `result`（失败与被拒）。

现成的翻译层：`bridge/pascal_events.py` 覆盖 **Claude Code 系**的三家
（CC / Codex / WorkBuddy），新增一家 CC 系的通常只是加一份配置表：

```python
WORKBUDDY = {
    "id": "workbuddy", "label": "WorkBuddy",
    "turn_fields": ("prompt_id", "turn_id"),   # 按顺序取第一个有值的
    "reset_sources": ("startup", "clear"),     # 其余 source 是同一局的延续
    "events": {...},                           # 少发的事件直接忽略即可
}
```

---

## 3. 状态词表（形象层消费的东西）

**8 个互斥基态**：

| 基态 | 语义 |
|:--|:--|
| `idle` | 没有正在进行的回合 |
| `reviewing` | 复核 / 验证已经产出的东西 |
| `writing` | 模型正在生成（思考、写回答、写代码） |
| `researching` | 为了弄清情况而读取（检索、查文件、看文档） |
| `executing` | 正在跑工具，会改变外部世界 |
| `syncing` | 与外部服务或另一个 agent 往来 |
| `awaiting` | 在等人 —— 等输入、等授权、等另一个 agent 回话 |
| `error` | 由 harness 的权威字段判定的失败，不是从输出里猜的 |

对用户展示时 `writing` 与 `researching` 合并成「思考中」，避免多工具回合里文案来回跳；
内部仍分开，因为它们的表情不同。

优先级（并发时显示哪个）：
`error > awaiting > syncing > executing > researching > writing > reviewing > idle`

**2 个叠加 reaction**（一次性反应，不改基态）：`blocked`、`interrupted`。

**`speaking` 不走本协议** —— 它由音频层自己算（见 §5）。

### 兼容性承诺

新增基态时，形象**不必**为每个新态单独配动作。`STATE_FALLBACK`（`src/types.ts`）
给新态指定一个回落目标，老的 manifest 一行不改继续可用。
`syncing` 拆成 `awaiting` / `reviewing` / `syncing` 时就是靠这条没有破坏既有模型。

→ **协议可以加状态，不会让第三方形象失效。**

---

## 4. Wire format

一个 JSON 文件，形象层轮询（5Hz）。刻意选文件而不是 socket/daemon：
零依赖、零端口、进程崩了不影响对方、跨语言零成本。**等真出现第二个客户端再谈传输升级。**

```
$TMPDIR/agent-avatar-state.json                Hermes（历史默认路径）
$TMPDIR/agent-avatar-state.<harness>.json      其余每家一个
```

每家写自己的文件，所以同时开多个 agent 不会互相抢。形象层按「状态来源」设置读其中一个，
或按 mtime 取最新（自动）。

```json
{
  "state": "executing",
  "detail": "Claude Code is running a tool",
  "sequence": 42,
  "updated_at": "2026-08-28T14:25:48.105089Z",
  "reaction": { "kind": "blocked", "sequence": 3, "at": 1787927473.9 },
  "audio":    { "token": "…" }
}
```

| 字段 | 说明 |
|:--|:--|
| `state` | 8 基态之一。**必需** |
| `detail` | 人类可读，主语是 harness 名 |
| `sequence` | 单调递增，客户端据此判断有没有新快照 |
| `updated_at` | UTC ISO8601 |
| `reaction` | 可选叠加层。**去重键是 `at`（单调时间戳），不是 `sequence`** —— 后者存在易失文件里、会复位，用它去重会整整吞掉一次反应 |
| `audio` | 可选，harness 专属带出物（Hermes 的会话 token） |

**过期兜底**：客户端按文件 mtime 判断，超过 300s 的忙态一律当 `idle`。
会话被杀时最后的忙态会永远留在文件里，没有这条就会一直卡着。

文件权限 **0600**（可能含凭据）。写入用 `os.replace` 保证原子性；
**不做 `fsync`** —— 瞬态文件不需要掉电持久性，而 in-process 插件路径下每毫秒都加在 agent 主循环上。

---

## 5. 音频**不进**本协议（明确的设计决定）

口型由**系统音频**驱动，不走 bridge。理由是实测出来的：

五家 harness 里**只有 Hermes 有 TTS 流**。Codex Voice、ChatGPT 语音模式、
社区的本地 TTS —— 全都从系统音频出声，一个 Core Audio process tap 就全收了，
**零对接**（macOS：`CATapDescription` + `AudioHardwareCreateProcessTap`，
不需要屏幕录制权限）。

把 `audio.chunk` 塞进协议，等于为 3/5 的 harness 定义一套它们**永远不会实现**的规格
—— 它们根本不控制 TTS。

→ **semantic 走桥，audio 走带外。** Hermes 的 TTS 流是可选增强，不是协议的一部分。

---

## 5.5 各家的信任模型不同（接入前先搞清楚）

三家把闸门设在不同位置，直接影响「用户装完之后还要做什么」：

| harness | 闸门 | 粒度 | 升级后是否失效 |
|:--|:--|:--|:--|
| **Hermes** | 启用插件 = 同意 | 按插件 | 否 |
| **Codex** | 启用 ≠ 信任 hook，要在会话里 `/hooks` 逐条审 | **按 hook 内容哈希** | **是 —— 每次改 hooks.json 都要重审** |
| **Claude Code** | 安装 = 信任，装前看 `/plugin` 的 "Will install" | 按插件 | 否 |
| **DeepSeek Harness** | 写进用户 patch 层即生效（`$DSH_HOME/cordis.patch.yml`），无额外审批 | 按 entry | 否（HMR 热加载） |
| **WorkBuddy** | 本地 marketplace 登记 + `plugin install` | 按插件 | 否（app 需重启一次） |

Hermes 另有一道闸，但管的是**别的东西** —— 「插件能否替换内置工具」（`shell_exec` /
`write_file` 那类）。观察者不需要，也**绝不要申请**。

**Codex 那条最容易让人以为坏了**：插件显示「已安装、已启用」，但 hook 被**静默跳过**，
没有报错、没有提示。实测确认：同一条命令加 `--dangerously-bypass-hook-trust` 就立刻工作。
接入文档必须写明这一步，否则用户装完发现「没反应」会当成 bug。

### 零上下文开销

纯观察者插件不往对话里塞任何内容。Claude Code 会明确标出来：

```
Hooks (10) ... (harness-only — no model context cost)
Always-on:   ~0 tok   added to every session
```

这是「只写状态文件、绝不返回指令」的直接回报，也是接入方最该关心的成本指标。

---

## 6. 接入一个新 harness 要做什么

1. **读它的官方 hook 文档**，然后**实机抓一轮 stdin**。文档和实际不符是常态 ——
   我们已经撞到过好几次（`SessionStart(source=clear)` 在 Claude Desktop 上根本不发；
   `hermes hooks test` 的合成 payload 对子代理事件不可信）。
2. 如果它是 Claude Code 系的：往 `bridge/pascal_events.py` 加一份配置表 + 一个 ~40 行入口。
   **先确认它真的是** —— DeepSeek Harness 曾被判为「自带 CC hook bridge、零改动」，
   实机一看根本没有那个包，它的扩展点是 cordis 事件。
3. 否则：写一个翻译层，把它的事件映射到 §2 的词表（dsh 的样子见 `connectors/dsh/`：
   翻译在 in-process 插件里，状态机仍复用同一份）。
   **闭源也照接**：WorkBuddy 是闭源 Electron app，但它的 agent core 是随包分发的
   CodeBuddy Code CLI，hook 是外部进程契约 —— 我们只从 stdin 读 JSON，不需要它的源码。
4. **只注册纯观察类事件**（见 §7）。
5. 把它加进形象层的 harness 白名单（`hermes.rs` 的 `HARNESSES`、`prefs.ts` 的 `STATE_SOURCES`）。

---

## 7. 🔴 安全约束（不是建议）

**观察者绝不能出现在决策链路上。**

1. **永远 `exit 0`。** Claude Code 有 14 个事件把退出码 2 当作 block
   （`PreToolUse` 拦工具、**`Stop` 阻止停止 → 对话停不下来**、`SubagentStop`…），
   Codex 连 `PostToolUse` 都算。而 **`python3 <不存在的文件>` 的退出码恰好是 2**。
   → 注册命令一律写成 `... ; exit 0`。实测对照：不加，路径失效时**工具被拦死**；加了，正常执行。
   Hermes 上真实发生过一次（2026-08-28，脚本移动后进程未重启，agent 完全无法工作）。
2. **绝不注册阻塞式决策 hook。** `PermissionRequest` 在接收端不可用时会让 CC
   **直接拒绝工具调用**而不是回落到自己的确认框
   （[anthropics/claude-code#46193](https://github.com/anthropics/claude-code/issues/46193)）。
   要「被拒」这个信号，只用被动的 `PermissionDenied`；没有就不要。
3. **注册清单是白名单，不是「能注册的都注册上」。** 有些事件要求 hook **干活**：
   `WorktreeCreate` 必须往 stdout 打印新 worktree 路径，被动 hook 会让 `claude -w` 直接报错。
4. **stdout 必须为空。** 有输出的话会被解释成决策或注入上下文。
5. **回调跑在 harness 进程内时，按「派发模式」挑事件。** 五家全都是 hook 机制，
   差别只在回调在哪跑：Claude Code / Codex 起子进程（`hooks.json` 注册命令），
   Hermes（`ctx.register_hook`）与 dsh（cordis `ctx.on`）是**进程内回调**。
   进程内那两家没有「退出码」这回事，风险换成两样：卡住就是卡住 agent 主循环
   （所以状态机用非阻塞锁 + 有界重试），以及**返回值可能被当成指令** ——
   同一个事件总线上既有纯通知也有决策点。dsh 在 `.d.ts` 里标了 `@mode`：
   `emit` 是纯通知（返回值不参与判定，**只订阅这些**），而 `waterfall` / `serial` /
   `bail` 的返回值会改变 harness 行为 —— 订阅它们就等于站进了决策链路。
   代价要认：dsh 的「工具开始」只有 waterfall 的 `tools/pre-execute`，
   我们改从 emit 的 `session/event`（`tool/call`）取，信息一样全。

---

## 8. 参考实现

| | 位置 |
|:--|:--|
| 状态机（stdlib only，harness 无关） | `bridge/state_machine.py` |
| Claude Code 系翻译层（3 家共用） | `bridge/pascal_events.py` |
| Hermes 适配（插件 + shell hook 两条入口） | `connectors/hermes/` |
| Claude Code / Codex / WorkBuddy 适配 | `connectors/{claude-code,codex,workbuddy}/` |
| DeepSeek Harness 适配（cordis 插件，**非 CC 系**） | `connectors/dsh/` |
| 各家的插件包与安装脚本 | `connectors/{hermes,claude-code,codex,dsh,workbuddy}/` |
| 插件组装（把 Bridge 拷进插件目录，产出自包含的树） | `connectors/assemble.sh` |
| 形象层消费端（Rust） | `desktop/src-tauri/src/hermes.rs` |
| 状态 → 动作/表情 | `desktop/src/types.ts`、`desktop/src/manifest.ts` |

各家的注册方式与实机验证状态见各自目录下的 `README.md`。
