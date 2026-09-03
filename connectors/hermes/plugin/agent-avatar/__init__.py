"""Agent Avatar's Hermes plugin — a pure observer: it writes a state file and
changes nothing about how Hermes behaves.

**This is the default way to connect.** Compared with the shell hook, it does not
touch the user's `config.yaml` (YAML is user-owned), does not need a shell-hook
allowlist, and does not need `hooks_auto_accept: true` (a global switch meant for
CI/headless that would silently accept **every** unseen shell hook).
Installation: see `docs/HERMES-SETUP.md`.

The state machine is shared with the shell-hook entry point (`state_machine.py`,
copied into this directory at install time). `_payload()` mirrors the translation
in `agent/shell_hooks.py:_serialize_payload()`, so both entry points hand the
state machine **the same shape** — no second code path just for the plugin.
"""

from .state_machine import update

LABEL = "Hermes"

# Only pure-observation events are registered. **This is an allowlist, not
# "register everything we can"**: the return value of Hermes hooks such as
# `pre_tool_call` and `pre_verify` is interpreted as a block/approve decision, and
# an observer must never sit in the decision path. All our callbacks return None
# (no instruction).
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

# Matches _TOP_LEVEL_PAYLOAD_KEYS in agent/shell_hooks.py: these keys are lifted
# to the top level, everything else in kwargs goes into `extra` untouched.
_TOP_LEVEL_KEYS = frozenset({"tool_name", "args", "session_id", "parent_session_id"})


def _payload(event, kwargs):
    return {
        "hook_event_name": event,
        "tool_name": kwargs.get("tool_name"),
        "tool_input": kwargs.get("args") if isinstance(kwargs.get("args"), dict) else None,
        # subagent_stop carries only parent_session_id, no session_id — fall back
        # exactly the way the shell hook does.
        "session_id": kwargs.get("session_id") or kwargs.get("parent_session_id") or "",
        "extra": {key: value for key, value in kwargs.items() if key not in _TOP_LEVEL_KEYS},
    }


def _make_callback(event):
    def callback(**kwargs):
        # Hermes's invoke_hook already wraps us in try/except, but it has **no
        # timeout** — blocking here blocks the agent's main loop. The real defence
        # is therefore in state_machine.update(): a non-blocking lock with bounded
        # retries. This extra catch exists purely to keep warnings out of agent.log.
        try:
            update(_payload(event, kwargs), LABEL, _audio())
        except Exception:
            pass
        return None  # observer: never returns an instruction
    callback.__name__ = "agent_avatar_" + event
    return callback


def _audio():
    """Pass Hermes's session token to the skin (audio-link auth, see
    docs/HERMES-STATE-TAXONOMY.md).

    Returns None when there is nothing to pass — the state machine then keeps the
    previous value instead of overwriting it with an empty one. Gateway and cron
    sessions are not descendants of the desktop process, so the variable is simply
    absent in their environment.
    """
    import os
    token = os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", "").strip()
    return {"token": token} if token else None


def register(ctx):
    for event in HOOKS:
        ctx.register_hook(event, _make_callback(event))
