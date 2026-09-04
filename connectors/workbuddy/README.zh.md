# WorkBuddy 接入指南

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

> 实机验证：**2026-08-28，WorkBuddy（macOS app，闭源）—— app 内新会话与其自带的
> CodeBuddy Code CLI v2.115.0 都已跑通**。轨迹：`writing → executing → writing → idle`。

## WorkBuddy 的 agent core 是 CodeBuddy Code

Electron 壳里没有 hook 系统，真正跑 agent 的是随 app 分发的 CLI：

```
/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
```

它就是 **CodeBuddy Code**，Claude Code 的形状：`hook_event_name` 的 stdin 契约、
`hooks/hooks.json` 的插件布局、`-p` 无头模式、`--settings` 隔离配置、`--plugin-dir` 本地加载。
**闭源不构成障碍** —— hook 是外部进程契约，我们只从 stdin 读 JSON。

插件里 `${CODEBUDDY_PLUGIN_ROOT}` 与 `${CLAUDE_PLUGIN_ROOT}` **两个变量都会被设置**
（CLI 里同时写入），所以 Claude Code 的插件目录原样就能被它加载 —— 实测确认。

## 1. 安装

**app 会替你装**：设置 → Agent → 接入 → 安装。

手动装 —— 给 app 够不着的 WorkBuddy，或者你想先读命令：

```sh
sh connectors/build-bundle.sh ./connector-tree
cd connector-tree/marketplace
python localize.py workbuddy
codebuddy plugin marketplace add ./
codebuddy plugin install agent-avatar@agent-avatar
```

形状与 Claude Code 一样，只是把 `claude` 换成 `codebuddy`。完整说明见
[连接器 README](../marketplace-README.zh.md)。

🔴 **装进哪个 home 是关键。** 同一个 CLI 有两个配置目录：独立跑 CLI 时默认 `~/.codebuddy`，
而 **WorkBuddy app 读 `~/.workbuddy`**（app 侧 `WORKBUDDY_CONFIG_DIR`，CLI 侧
`CODEBUDDY_CONFIG_DIR`）。装错 home 的表现最迷惑人：**命令行怎么测都正常、app 里新会话
完全没反应**（实机撞到过）。只用 app 的话，装之前把 `CODEBUDDY_CONFIG_DIR` 指到
`~/.workbuddy`。

`localize.py` 负责把解释器绝对路径写进 hook 命令行 —— **Windows 上不是可选项**：
那里的 `python3` 解析到一个 0 字节的应用商店存根，能启动、打印「Python was not found」、
以 9009 退出；9009 不是 2，所以不会被当成失败，唯一的表现就是形象一直不动。
Windows 上也没有 app 自带 CLI 的固定路径：设 `CODEBUDDY_CLI`，或者用
`npm install -g @tencent-ai/codebuddy-code` 装一个。

装完 **app 要重启**才加载（CLI 下次运行即生效；会话里也可以 `/reload-plugins`）。

卸载（**同样要指对 home**，否则删的是另一份）：
```sh
CODEBUDDY_CONFIG_DIR=~/.workbuddy codebuddy plugin uninstall agent-avatar
CODEBUDDY_CONFIG_DIR=~/.workbuddy codebuddy plugin marketplace remove agent-avatar
```

## 2. 原来写在这份文档里的三条判断，全是错的

旧版本按「WorkBuddy 声称兼容 Claude Code」推断，结果被实物否掉：

| 旧判断 | 实际 |
|:--|:--|
| 配置在 `~/.workbuddy-ai/settings.json` | **`~/.workbuddy/settings.json`**（transcript 在 `~/.codebuddy/projects/`） |
| 没有子代理事件 | `SubagentStart` / `SubagentStop` 都有 |
| 没有 `PostToolUseFailure`、没有 `PermissionDenied` | 都有（`PermissionDenied` 实机抓到过一条） |

CLI 里的完整词表：

```
SessionStart SessionEnd UserPromptSubmit PreToolUse PostToolUse PostToolUseFailure
Stop SubagentStart SubagentStop PermissionDenied PermissionRequest PreCompact
PostCompact WorktreeCreate WorktreeRemove
```

后三类按 §7 一律不注册（`PermissionRequest` 是阻塞式决策、`WorktreeCreate` 要求 hook 干活）。

## 3. 两个真差别（都是实抓出来的）

实机时序（`sleep 4`）：

```
UserPromptSubmit  0.00s
SessionStart      0.41s   ← **在回合开始之后**
PreToolUse        4.31s   （Bash, tool_use_id=call_…）
PostToolUse       8.37s
Stop             10.00s
```

**其一：SessionStart 迟到。** Claude Code 是先 `SessionStart` 再 `UserPromptSubmit`，
WorkBuddy 反过来。把迟到的 `SessionStart(startup)` 当成重置，会清掉刚开的回合，
随后的工具就被 `display_state` 判为「所属 turn 已收尾」而跳过 —— **整轮没有 executing**。
所以配置表里 `reset_sources` 只留 `clear`：startup 时会话本来就是新的，不重置没有损失。

**其二：没有回合字段。** `prompt_id` 与 `turn_id` 在 payload 里都不存在
（其 CLI 里这两个字符串出现 **0 次**）。翻译层退回 `session_id` —— 一个会话同一时刻只跑
一个回合，边界由 `UserPromptSubmit` / `Stop` 给出。不回落的话 turn 记账全空，
工具之间会闪回 idle。

> `generation_id` 看着像回合，其实不是：它是**每次模型生成**一个，
> `Stop` 那条与工具那条不同。拿它当回合 id 会关不掉工具所属的回合。

## 4. 取样（接入前的第一步）

```sh
CLI=/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
"$CLI" -p --settings <取样器settings.json> -- "用 bash 执行 sleep 4，然后只回答 done"
```

settings 里把每个事件的命令写成 `python3 ../sample-stdin.py ; exit 0`，
输出在 `$AGENT_AVATAR_SAMPLE`。**用隔离的 `--settings`，不碰用户自己的配置。**

两个坑：

- `--plugin-dir` 是**变长参数**，会把后面的 prompt 一起吃掉 —— 要写成
  `--plugin-dir DIR -- "prompt"`，否则 CLI 静默 exit 0、什么都不答。
- 非交互模式下工具需要放行，在隔离 settings 里加 `"permissions": {"allow": ["Bash(sleep:*)"]}`，
  比 `-y`（绕过全部权限检查）安全。

## 5. 还没验的

- **子代理轨迹**没实跑（词表里有 `SubagentStart` / `SubagentStop`，用例是构造的）。
- `SessionStart` 的其余 source（`resume` / `compact` / `clear`）没实抓过，
  沿用 Claude Code 的判断（同一份 CLI）。
