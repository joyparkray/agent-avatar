# Hermes 适配层（可整体摘除的边界）

> M1 §1.2 的落点：**删掉这条边界，Agent Avatar 仍然完整可用** —— 形象、动作、文件/全局音源都不依赖
> Hermes。装了 Hermes 的用户额外获得语义表情与 TTS 口型。

## 边界包含什么

| 位置 | 作用 |
|:--|:--|
| `plugin/agent-avatar/` | **默认接入方式**：Hermes 插件（`plugin.yaml` + `__init__.py`），事件翻译 + token 带出 |
| `install-plugin.sh` | 把插件三个文件拷进 `~/.hermes/plugins/agent-avatar/`，**不碰用户的 config.yaml** |
| `agent-avatar-hook.py` | 备用的 shell hook 入口，行为与插件一致 |
| `test_agent_avatar_hook.py` / `test_agent_avatar_plugin.py` | 两条入口的单测，不依赖皮肤、不依赖任何第三方项目 |
| `../../src-tauri/src/hermes.rs` | `read_semantic_state` / `discover_audio_endpoint` 两个 Tauri 命令 |
| `../../../docs/HERMES-SETUP.md` | 用户如何安装 |

**不在这条边界里**：`../../bridge/state_machine.py` 是 harness 无关的共用状态机（M3 起由
Claude Code / Codex 等适配层共用），摘 Hermes 时**不要删它**。

## 两条入口，一个状态机

```
Hermes 插件 (in-process)  ┐
                          ├─► _payload() 翻译 ─► bridge/state_machine.update() ─► 状态文件
shell hook (子进程)        ┘
```

`plugin/agent-avatar/__init__.py` 的 `_payload()` 复刻了 `agent/shell_hooks.py:_serialize_payload()`
的翻译规则，所以**两条入口喂给状态机的 payload 是同一个形状** —— 状态机里没有为插件写的第二套分支。

Hermes 的事件名**就是**状态机的内部事件词表（历史形成，不是依赖），
所以 Hermes 这层不需要事件名映射表；别家 harness 需要。

## 为什么插件是默认（而不是 shell hook）

- 不改用户的 `~/.hermes/config.yaml`（YAML 是 user-owned，改坏了是我们的锅）；
- 不需要 shell-hook allowlist，也不需要 `hooks_auto_accept: true`
  —— 那是 Hermes 给 CI/headless 用的全局开关，会让**所有**未见过的 shell hook 免确认；
- 事件列表在 `plugin.yaml` 里是一个 YAML 列表，「10 段 YAML 漏一段」的坑不存在。

代价：插件 in-process 运行，而 Hermes 的 `invoke_hook` 只包了 try/except、**没有超时**。
所以 `bridge/state_machine.py` 的落盘是非阻塞的（`LOCK_NB` + 0.5s 有界重试，拿不到就丢事件），
且不做 `fsync` —— 瞬态状态文件不需要掉电持久性，`os.replace` 的原子性够了。

## 怎么摘

1. 删掉本目录（保留 `../../bridge/`）。
2. 删 `src-tauri/src/hermes.rs`，并从 `lib.rs` 去掉 `mod hermes;` 与 `generate_handler!` 里那两个
   `hermes::` 命令。

前端不用动：`SemanticDriver` 调不到命令会走失败降级（连续 3 次读不到 → 常驻 `idle`），
`discover_audio_endpoint` 缺失时不会建立 Hermes WS，右键菜单里 Hermes 音源拿不到端点而已。
文件 / 全局音源与形象动作完全不受影响。

## 与上游的关系

状态机移植自 `Star-Office-UI-Hermes/integrations/hermes/star_office_hook.py`（MIT，出处保留在文件头）。
**没有**移植 `push()`（上报 Star Office 后端的 HTTP）与其投递编排 —— Agent Avatar 只消费聚合后的基态。
运行期对该项目**零依赖**：本目录与 `../../bridge/` 都是 stdlib only，Rust 侧只读自己写的状态文件。
