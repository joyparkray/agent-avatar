#!/usr/bin/env python3
"""Shared translation layer for the Claude Code family of event vocabularies (stdlib only).

**Shared by four harnesses**: Claude Code, Codex, DeepSeek Harness and WorkBuddy.
Their event names, stdin field names and registration structures are highly
isomorphic (`hook_event_name`, `session_id`, `tool_use_id` and `agent_id` are all
common fields), and the differences are small enough to express as a config
table — hence one translation function plus one config per harness, rather than
four copy-pasted scripts.

Where the contract comes from: each vendor's own documentation plus captures on
real hardware (two full turns including subagents were captured from Claude Code
2.1.212 with an isolated --settings sampler; see docs/DESIGN-M3-MULTI-HARNESS.md
§2.6/§2.8).
"""

# Shared event map. Each harness trims it to what it actually emits — anything not
# found in the map is ignored, so "this harness doesn't send that event" needs no
# special handling at all.
_BASE_EVENTS = {
    "UserPromptSubmit": "pre_llm_call",
    "PreToolUse": "pre_tool_call",
    "PostToolUse": "post_tool_call",
    "SubagentStart": "subagent_start",
    "SubagentStop": "subagent_stop",
    "Stop": "post_llm_call",
    "SessionEnd": "on_session_finalize",
}

CLAUDE_CODE = {
    "id": "claude-code",
    "label": "Claude Code",
    # Measured: constant from UserPromptSubmit through Stop within one turn, a new
    # value on the next turn, while session_id stays the same.
    "turn_fields": ("prompt_id",),
    # Only these two sources mean "a new session begins". resume/compact/fork are
    # continuations of the same one — treating them as a full reset would wipe out
    # live subagents and running tools.
    "reset_sources": ("startup", "clear"),
    "events": dict(_BASE_EVENTS,
                   # Claude Code has a dedicated event for tool failure, which is
                   # more explicit than inferring it from a return value
                   PostToolUseFailure="post_tool_call",
                   # The passive "was denied", not the blocking PermissionRequest
                   PermissionDenied="post_tool_call"),
}

CODEX = {
    "id": "codex",
    "label": "Codex",
    # Codex gives turn_id directly (per its docs, every turn-scoped hook carries it).
    "turn_fields": ("turn_id",),
    # Its documented sources are only startup/resume/clear/compact — no fork like CC.
    "reset_sources": ("startup", "clear"),
    # No PostToolUseFailure (errors are inferred from tool_response) and no
    # PermissionDenied (only the blocking PermissionRequest — never registered, see below).
    "events": dict(_BASE_EVENTS),
}

# 🔴 Events we **never map and never register**, and why:
# - PermissionRequest: a blocking decision hook. It caused a real outage in Claude
#   Code — with no receiver present it denied the tool call outright instead of
#   falling back to the confirmation dialog (anthropics/claude-code#46193).
#   An expression system must never enter the permission decision path.
# - WorktreeCreate: expects the new worktree path on stdout; a passive hook makes
#   `claude -w` fail.
# - PreCompact / PostToolBatch / TaskCreated / ...: no new information; allowlist principle.
_NEVER = frozenset({"PermissionRequest", "WorktreeCreate", "PreCompact", "PostCompact",
                    "PostToolBatch", "TaskCreated", "TaskCompleted", "TeammateIdle",
                    "UserPromptExpansion", "ConfigChange", "Elicitation", "ElicitationResult"})


def translate(payload, harness):
    """Harness payload → state-machine payload. None means this event must not drive the avatar."""
    event = payload.get("hook_event_name")
    if event in _NEVER:
        return None

    # Events from inside a subagent carry agent_id — and carry the **parent's**
    # session_id (confirmed on real Claude Code hardware; Codex documents the same
    # fields). Letting them through would let one failing tool inside a subagent
    # push the avatar into `error` while the parent session is perfectly fine.
    # SubagentStart/Stop also carry agent_id, but those are the parent's bookkeeping.
    if payload.get("agent_id") and event not in ("SubagentStart", "SubagentStop"):
        return None

    if event == "SessionStart":
        if payload.get("source") not in harness["reset_sources"]:
            return None
        internal = "on_session_start"
    else:
        internal = harness["events"].get(event)
        if internal is None:
            return None

    # stop_hook_active means this Stop is a continuation after another hook blocked
    # stopping — not a real end of turn. Treating it as one makes the avatar blink
    # to idle and jump straight back.
    if event in ("Stop", "SubagentStop") and payload.get("stop_hook_active") is True:
        if event == "Stop":
            return None

    out = {
        "hook_event_name": internal,
        "session_id": payload.get("session_id") or "",
        # The turn-id field is named differently per harness (prompt_id in CC,
        # turn_id in Codex). Take the first one that has a value, and **fall back to
        # session_id when none does**: WorkBuddy has neither (measured, and its CLI
        # contains zero occurrences of the strings `prompt_id` / `turn_id`), and an
        # empty turn_id means the state machine does no turn bookkeeping at all —
        # which shows up as no `writing` for the whole turn and a blink back to idle
        # between tools (exactly what we observed).
        # Falling back to the session is safe: these harnesses run only one turn at a
        # time per session, and the turn boundaries come from UserPromptSubmit / Stop,
        # which carry session_id anyway.
        "turn_id": next((str(payload[key]) for key in harness["turn_fields"]
                         if payload.get(key)), "") or str(payload.get("session_id") or ""),
        "tool_name": payload.get("tool_name"),
        "tool_input": payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else None,
        "tool_use_id": payload.get("tool_use_id"),
    }

    # Subagent identity is agent_id here, not Hermes's child_session_id. Convert it
    # to the key the state machine knows.
    if event in ("SubagentStart", "SubagentStop"):
        out["child_session_id"] = payload.get("agent_id")

    # Codex has no PostToolUseFailure, so an error can only be inferred from the
    # tool's return value — that is what the state machine's has_error() is for (it
    # parses error / is_error / success / exit_code out of the result). CC carries
    # tool_response too, so pass it through for both: even if a user forgot to
    # register PostToolUseFailure, there is still a fallback.
    if "tool_response" in payload:
        out["result"] = payload["tool_response"]
    if event == "PostToolUseFailure":
        out["status"] = "error"
    # Denied = a `blocked` overlay reaction (the base state does not change), the
    # same convention as Hermes's status="blocked".
    if event == "PermissionDenied":
        out["status"] = "blocked"
    return out


# WorkBuddy's agent core is the CodeBuddy Code CLI shipped inside the app (v2.115.0
# on the machine we tested), and its hook vocabulary is **identical** to Claude
# Code's — including PostToolUseFailure, PermissionDenied, SubagentStart and
# SubagentStop. The three "fewer capabilities" claims that used to be written here
# were all wrong (guessed from its compatibility statement).
# The one real difference: **no turn field at all** (neither `prompt_id` nor
# `turn_id` exists), so it uses the session fallback above.
# Config lives in `~/.workbuddy-ai/settings.json` (the older `~/.workbuddy/settings.json`
# is only a fallback).
WORKBUDDY = {
    "id": "workbuddy",
    "label": "WorkBuddy",
    # Measured: neither candidate field exists, so the session fallback carries it
    "turn_fields": (),
    # ⚠️ **Does not include startup** (the opposite of CC). The real captured order is
    # `UserPromptSubmit → SessionStart(startup) → PreToolUse → …` — WorkBuddy's
    # SessionStart arrives **after** the turn has begun. Treating it as a reset wipes
    # the turn that just started, so display_state decides the tool's "owning turn is
    # already finished" and skips it: no executing for the whole turn, just writing
    # dropping back to idle (exactly the shape we measured).
    # At startup the session is new anyway, so not resetting costs nothing; the source
    # that genuinely needs a reset is clear.
    "reset_sources": ("clear",),
    # 🔴 **无头模式下它根本不发 UserPromptSubmit。** 上面那条讲的是同一个症状的另一个成因
    # （SessionStart 被当成 reset，把刚开始的轮次抹掉）；那个修好之后，`codebuddy -p`
    # 这条路仍然坏着 —— 因为它压根没有那一步。2026-09-04 在 Windows 上给已装的 hook
    # 加埋点，抓到的完整事件流是：
    #
    #     SessionStart → PreToolUse → PreToolUse → PostToolUse → PostToolUse → Stop
    #
    # 对照（同一条工具载荷、同一个 session_id）：只发 PreToolUse 得到
    # `state=writing doing=None`；前面补一个 UserPromptSubmit 就是
    # `state=researching doing=README.md`。
    #
    # 于是打开这个开关：工具事件自己把轮次补登记上。交互模式下 UserPromptSubmit 照样先到，
    # 轮次已经在了，这个开关不会生效 —— 所以两种模式共用一份配置是安全的。
    "lazy_turns": True,
    "events": dict(_BASE_EVENTS,
                   PostToolUseFailure="post_tool_call",
                   PermissionDenied="post_tool_call"),
}
