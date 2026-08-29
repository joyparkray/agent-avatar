"""Agent Avatar 的 Hermes 插件 —— 纯观察者，只写状态文件，不改变 Hermes 任何行为。

**这是默认接入方式。** 相比 shell hook：不改用户的 `config.yaml`（YAML 是 user-owned）、
不需要 shell-hook allowlist、不需要 `hooks_auto_accept: true`
（那是给 CI/headless 用的全局开关，会让**所有**未见过的 shell hook 免确认）。
安装见 `docs/HERMES-SETUP.md`。

状态机与 shell hook 入口共用（`state_machine.py`，安装时一并拷进本目录）。
`_payload()` 复刻 `agent/shell_hooks.py:_serialize_payload()` 的翻译，
两条入口喂给状态机的 payload 因此是**同一个形状**——不必为插件写第二套分支。
"""

from .state_machine import update

LABEL = "Hermes"

# 只注册纯观察类事件。**这是白名单，不是「能注册的都注册上」**：Hermes 的
# `pre_tool_call` / `pre_verify` 等 hook 的返回值会被解释成 block/approve 指令，
# 观察者插件绝不能出现在决策链路上。我们的回调一律返回 None（无指令）。
HOOKS = (
    "on_session_start",
    "on_session_reset",
    "pre_llm_call",
    "post_llm_call",
    "pre_tool_call",
    "post_tool_call",
    "subagent_start",
    "subagent_stop",
    "on_session_end",
    "on_session_finalize",
)

# 与 agent/shell_hooks.py 的 _TOP_LEVEL_PAYLOAD_KEYS 一致：这几个键被提到顶层，
# 其余 kwargs 原样进 `extra`。
_TOP_LEVEL_KEYS = frozenset({"tool_name", "args", "session_id", "parent_session_id"})


def _payload(event, kwargs):
    return {
        "hook_event_name": event,
        "tool_name": kwargs.get("tool_name"),
        "tool_input": kwargs.get("args") if isinstance(kwargs.get("args"), dict) else None,
        # subagent_stop 只带 parent_session_id，没有 session_id —— 与 shell hook 同口径回落。
        "session_id": kwargs.get("session_id") or kwargs.get("parent_session_id") or "",
        "extra": {key: value for key, value in kwargs.items() if key not in _TOP_LEVEL_KEYS},
    }


def _make_callback(event):
    def callback(**kwargs):
        # Hermes 的 invoke_hook 已经包了 try/except，但它**没有超时** —— 卡住就是卡住
        # agent 主循环。所以真正的防线在 state_machine.update()：非阻塞锁 + 有界重试。
        # 这里再兜一层异常，纯粹是为了不往 agent.log 刷 warning。
        try:
            update(_payload(event, kwargs), LABEL, _audio())
        except Exception:
            pass
        return None  # 观察者：永不返回指令
    callback.__name__ = "agent_avatar_" + event
    return callback


def _audio():
    """把 Hermes 的会话 token 带给皮肤（音频链路鉴权，见 docs/HERMES-STATE-TAXONOMY.md）。

    拿不到时返回 None —— 状态机会沿用上一次的值而不是覆盖成空。
    gateway / cron 会话不是 desktop 后代，环境里本来就没有这个变量。
    """
    import os
    token = os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", "").strip()
    return {"token": token} if token else None


def register(ctx):
    for event in HOOKS:
        ctx.register_hook(event, _make_callback(event))
