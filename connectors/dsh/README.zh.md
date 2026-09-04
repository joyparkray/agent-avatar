# DeepSeek Harness 接入指南

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

> 实机验证：**2026-08-28，dsh 0.1.1-rc.2（headless profile）**。
> 轨迹与其余三家一致：`idle → writing → executing → writing → idle`。

## dsh **不是** Claude Code 系（原判有误）

M3 设计稿写的是「dsh 自带 CC hook bridge，零改动复用 Claude Code 的注册」。
**实机推翻**：这台机器上的 dsh 0.1.1-rc.2 里没有任何 hook 桥接包，
它的扩展点是 **cordis 事件**，事件名、载荷、注册方式与 CC 全不同 ——
`bridge/pascal_events.py` 那张表在这里用不上。

所以本目录是一个**翻译层 + in-process 插件**（BRIDGE-PROTOCOL §6.3 的路径），
而状态机仍然是共用的那一份。

| 文件 | 作用 |
|:--|:--|
| `plugin/agent-avatar/index.mjs` | cordis 插件：dsh 事件 → 内部词表 |
| `agent-avatar-hook.py` | 内部词表 payload → `bridge/state_machine.py` |
| `../localize.py dsh --register` | 钉死解释器 + 往 `$DSH_HOME/cordis.patch.yml` 加一条 insert |
| `sample-events.mjs` | 取样器（接入前实抓一轮用，见 §4） |

## 1. 安装

**app 会替你装**：设置 → Agent → 接入 → 安装。

手动装 —— 给 app 够不着的 dsh，或者你想先读命令：

```sh
sh connectors/build-bundle.sh ./connector-tree
cd connector-tree/marketplace
python localize.py dsh --register
```

dsh 根本没有插件 CLI：**注册本身就是 patch 文件里的一条 entry**，所以 `--register`
直接写 `$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh`），并先备份原文件。它是幂等的
（包括对着以前手贴进去的条目），`--unregister` 撤回，`--print-registration`
只打印不写。完整说明见[连接器 README](../marketplace-README.zh.md)。

这个文件被 dsh 的 HMR 监视着（`watchUserPatches`）—— **正在跑的 dsh 会热加载，不用重启**。
patch 是 home 级的，对所有 profile 生效。

> patch 文件允许 `!!js` 表达式，所以工具**按行处理、不做 YAML 解析** ——
> 拿普通解析器读会丢掉用户已有的表达式行。

两处 Windows 特有的坑，都已替你处理：

1. **`localize.py` 在这里不是可选项。** `index.mjs` 里那次 `spawn("python3")` ——
   这条链路 stderr 被 `ignore`、`error` 事件又只在 spawn 失败时触发，
   而应用商店存根**是能成功启动的**（打印「Python was not found」、以 9009 退出），
   所以是五家里最静默的一种坏法。本地化会把绝对路径写进 `index.mjs`
   （`AGENT_AVATAR_PYTHON` 环境变量仍然优先）。
2. **entry 的 `name` 必须是 `file:///` URL**：dsh 拿它当 ESM specifier 直接 `import()`，
   而 Node 会把 `C:/...` 当成 scheme 为 `c:` 的 URL，报
   `ERR_UNSUPPORTED_ESM_URL_SCHEME`（2026-09-02 实测）。手写路径基本都会写错，
   而且因为这条链路丢弃 stderr，坏了也不出声。

卸载：`python localize.py dsh --unregister`，再 `rm -rf $DSH_HOME/plugins/agent-avatar`。

## 2. 🔴 只订阅 `@mode emit` 的事件

dsh 在 `.d.ts` 里给每个事件标了派发模式，这一条直接决定观察者能碰哪些：

| 模式 | 例子 | 能不能订阅 |
|:--|:--|:--|
| `emit` | `session/event`、`session/created`、`subagent/start` | ✅ 纯通知，返回值不参与判定 |
| `waterfall` | `tools/pre-execute`、`tools/execute`、`agent/pre-step` | ❌ **在决策链路上**，返回值会改变 harness 行为 |
| `serial` | `agent/turn-stopping` | ❌ 同上 |
| `bail` | `slash/input-*` | ❌ 同上 |

这就是 BRIDGE-PROTOCOL §7.2 在 dsh 上的具体形态。**代价**：工具开始只有
waterfall 的 `tools/pre-execute`，我们不碰它 —— 好在 `session/event` 的
`tool/call` 是 emit，信息一样全（`callId` / `name`）。

## 3. 事件映射（实抓确认）

实机时序（`sleep 4`）：

```
session/created → turn/start(turn=1) → step/start(1,1) → tool/call(callId,name=bash)
→ tool/result(...) → step/end → step/start(1,2) → step/end → turn/end(reason.kind=completed)
```

| dsh | 内部事件 | 取值 |
|:--|:--|:--|
| `session/created` | `on_session_start` | `session.id` |
| `session/disposed` | `on_session_finalize` | |
| `session/event` `turn/start` | `pre_llm_call` | `turn_id = data.turn` |
| `session/event` `turn/end` | `post_llm_call` | |
| `session/event` `tool/call` | `pre_tool_call` | `tool_use_id = data.callId`、`tool_name = data.name` |
| `session/event` `tool/result` | `post_tool_call` | `tool_use_id = data.message.source.callId`、失败看 `content[].isError` |

**`tool/result` 的顶层没有 `callId`** —— 配对键藏在 `data.message.source.callId`。
拿错的后果是工具永远配不上、形象卡在 executing。

`assistant/chunk` 一轮几十条且不含状态信息，直接忽略。

## 4. 子代理：只挡不记账（两条实测理由）

1. **`subagent/start` 的监听器只收到一个实参**。`.d.ts` 里的 LifecycleEmitter 写成
   `(name, info, parent)`，但 `parent` 是 scope carrier，不会传给监听器。
   照文档写 → `session_id` 是 undefined → 记账落到子代理自己头上
   （实机：子会话的 `subagents` 里装着它自己，phase 永远停在 `writing`）。
2. **dsh 的子代理是后台 job**：父会话答完收工时 `subagent/end` 还没来（两轮都没等到）。
   按 start/stop 配对记 `awaiting`，形象会**永远卡在那个状态**。

所以 `subagent/start` 只做两件事：把子会话 id 记进忽略名单（它的事件不驱动形象），
并对它发一条 `on_session_finalize` 清掉可能已经建起来的记账（子代理的
`session/created` 可能早于这条通知）。父会话的 writing / executing 本来就是准的。

## 5. 接下来要复核的

- **web / tui profile 未实测**（本轮用 headless）。尤其是 `session/created` 在
  「恢复旧会话」时会不会也发 —— 会的话相当于把那局重置一次。
- `turn/end` 的 `reason.kind` 除了 `completed` 还有什么值：用户打断大概率在这里，
  能拿到就可以接上 `interrupted` 反应。
- 工具被拒（用户拒批准）走的是 `approval/request`（**waterfall，不能订阅**），
  所以 dsh 目前**没有 `blocked` 反应**。

## 6. 接入前的取样

```sh
dsh --profile headless --patch <patch.yml> "用 bash 执行 sleep 4"
```

patch 里 insert 一条指向 `sample-events.mjs` 的 entry，输出在
`$AGENT_AVATAR_SAMPLE`（默认 `/tmp/agent-avatar-dsh-sample.jsonl`）。
取样器**只订阅 emit 事件**，且**记全部实参** —— `session/event(session, event)`
是两个参数，只看第一个会把真正的事件整个漏掉（第一轮就是这么漏的）。

**务必用 `sleep 4` 这类慢工具**：快工具的 `executing` 只有几毫秒，会被误判成没接通。
