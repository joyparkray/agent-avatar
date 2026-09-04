#!/usr/bin/env python3
"""Agent Avatar's shared semantic state machine (stdlib only, harness-agnostic).

The **internal event vocabulary** reuses Hermes's event names (`pre_llm_call`,
`pre_tool_call`, ...) — that is a historical accident, not a dependency on Hermes.
Each harness's adapter translates its own event names into this vocabulary, and the
state machine itself knows about no specific harness. See
`docs/DESIGN-M3-MULTI-HARNESS.md` §3.1.

The state machine (`apply_event`, `display_state` and the classification helpers)
was ported from `Star-Office-UI-Hermes/integrations/hermes/star_office_hook.py`
(MIT). The HTTP reporting (`push`) and Star Office's delivery orchestration were
**not** ported — Agent Avatar consumes only the aggregated base state, whose
vocabulary is the 8-state contract in `docs/HERMES-STATE-TAXONOMY.md`.
"""

try:
    import fcntl
except ImportError:  # pragma: no cover - platform-specific fallback
    fcntl = None

try:
    import msvcrt
except ImportError:  # pragma: no cover - platform-specific fallback
    msvcrt = None

import json
import os
import re
import shlex
import sys
import tempfile
import time
from datetime import datetime, timezone

STATE_SCHEMA_VERSION = 2

# The connector's version, written into every snapshot.
#
# Why it is here: the installed connector is a **localised copy** (the interpreter
# path is baked in), so it does not update itself. It does not need to — it ships
# inside the app, which re-materialises it whenever the bundled version differs from
# the installed one. This field is how that comparison is made, and it is also what
# lets the app tell a snapshot written before this install from one written after:
# that difference is the only reliable way to notice that a connector which used to
# work has stopped.
#
# **Must match the version in all five plugin.json / plugin.yaml manifests** —
# build-bundle.sh compares them one by one and fails the build if they differ.
CONNECTOR_VERSION = "1.1.0"
# How long a reaction signal stays in the snapshot: the skin polls every 200 ms, so
# 2 s is enough for it to read the signal and fire it once (deduplicated by `at`).
REACTION_HOLD_SECONDS = 2.0
# 详情那一行在快照里活多久。**这不是装饰，是它能不能被看见的前提。**
#
# 🔴 详情只在工具跑着的那几档写（见 ACTIVITY_STATES），而工具结束时状态立刻回 idle。
# 快照是「当前值」，皮肤每 200 ms 采一次 —— 短于 200 ms 的窗口基本采不到。
# 2026-09-04 实机量过（5 ms 高频采样，Hermes）：
#
#     researching  doing='README.md'    停留  62 ms
#     researching  doing='.hermes'      停留  91 ms
#     researching  doing='README.md'    停留 184 ms
#     executing    doing=None          停留 5250 ms   ← 唯一够长的那个没有详情
#
# 三条带详情的窗口命中率约 31% / 46% / 92%，用户的原话是「看到一次一闪而过」。
# 所以详情要**比状态活得久一点**：状态照实回 idle（不撒谎），详情带一个明写的过期
# 时间继续挂着，皮肤过期就不显示。1 s 对 200 ms 轮询是必中，也短到不会让人以为还在跑。
DOING_HOLD_SECONDS = 1.0
BACKGROUND_REVIEW_MARKER = (
    "You can only call memory and skill management tools. "
    "Other tools will be denied at runtime"
)

# Priority decides which of several concurrent signals is shown.
# - reviewing sits below writing: it is background tidying after a turn ends, and as
#   soon as the user speaks again the live conversation deserves to be seen.
# - awaiting is the highest except for error: the whole turn is stuck waiting on
#   somebody else, which is more representative than any tool we happen to be running.
PRIORITY = {"idle": 0, "reviewing": 1, "writing": 2, "researching": 3,
            "executing": 4, "syncing": 5, "awaiting": 6, "error": 7}
# The subject is supplied by the adapter ("Hermes", "Claude Code", ...) — hardcoding
# "Hermes" would show users of every other harness "Hermes is running a tool".
DETAIL_PREDICATE = {
    "idle": "is ready",
    "reviewing": "is updating memory and skills",
    "writing": "is composing a response",
    "researching": "is researching",
    "executing": "is running a tool",
    "syncing": "is syncing an external service",
    "awaiting": "is waiting on another agent",
    "error": "encountered a tool error",
}


def detail_for(state, label):
    return label + " " + DETAIL_PREDICATE[state]


# ---------------------------------------------------------------------------
# "What exactly is it doing" — one short line, from the payload we already have
# ---------------------------------------------------------------------------

# The status pill's detail row wraps up to *two* lines (CSS -webkit-line-clamp:2, see
# style.css) at ~236 px usable width and 11 px font — about 37 latin characters per
# line, ~74-80 across both. The state label takes the line above, so the whole budget
# is this row's — but a search query can be 75 characters, so cap it here rather than
# letting the UI clip it. Matches the Rust-side secondary cap in hermes.rs (`take(80)`).
ACTIVITY_LIMIT = 80

# 带详情的那几档。idle / writing / awaiting 没有工具在跑，挂着上一个只会误导。
ACTIVITY_STATES = frozenset({"executing", "researching", "reviewing", "syncing", "error"})

# 🔴 **A whitelist, not a blocklist.** `tool_input` also carries `content` (a whole
# file body), `new_string`, and `command` — a command line can hold an auth header or a
# token, and it is the one field a user would never expect to see on screen. So this
# names the four things that are *about* the action rather than the material of it:
# the agent's own one-line description, which file, which host, what was searched.
#
# Keyed on **fields, not tool names**: the five harnesses name their tools differently
# (Bash / terminal / exec_command), but the input field that carries the human-readable
# part is the same. Order is priority — `description` beats a path because the agent
# wrote it for a human to read.
#
# 🔴 **Field names are per-harness, so the list has to cover all five.** Keyed on
# Claude Code's names alone, Hermes shows almost nothing: its tool schemas mostly say
# `path` (6 occurrences) and `filename` (2), against only 2 for `file_path` — measured
# 2026-09-03 across `hermes-agent/tools/`. The user's report was "Hermes only ever
# shows the top-level state"; `query` / `url` / `pattern` did land, which is why it
# looked intermittent rather than broken.
#
# `path` and `filename` are the same shape and the same privacy profile as `file_path`
# — a name on disk — and get the same basename reduction. `command` stays out, for the
# reason above.
ACTIVITY_FIELDS = ("description", "file_path", "path", "filename", "url", "query", "pattern",
                   "command")

# 只留文件名的那几个 —— 全路径既超长又常常泄露目录结构
PATH_FIELDS = frozenset({"file_path", "path", "filename"})


def _shorten(text):
    text = " ".join(str(text).split())          # newlines would break the one-line pill
    return text[:ACTIVITY_LIMIT - 1] + "…" if len(text) > ACTIVITY_LIMIT else text


def activity_from(payload):
    """The one line to show under the state, or None.

    Never raises: an unexpected shape costs the detail, not the event.
    """
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    # 🔴 有些调用把真正的参数又包了一层 `arguments`。实机抓到（2026-09-04，Hermes）：
    #     pre_tool_call tool=read_file tool_input_keys=['path']         ← 扁平
    #     pre_tool_call tool=read_file tool_input_keys=['arguments']    ← 包了一层
    # 同一个工具两种形状都出现过。包着的那种看不穿，详情就是空的 —— 而用户看到的是
    # 「时灵时不灵」。dsh 那边是同一个字段名（工具参数的 JSON 字符串），所以两处形状一致。
    # 只在它是**唯一的键**时才拆：那时候它必然是个信封，不可能是某个工具真叫 arguments 的参数。
    if set(tool_input) == {"arguments"}:
        inner = tool_input["arguments"]
        if isinstance(inner, str):
            try:
                inner = json.loads(inner)
            except Exception:
                inner = None
        tool_input = inner if isinstance(inner, dict) else {}
    for field in ACTIVITY_FIELDS:
        value = tool_input.get(field)
        if not isinstance(value, str) or not value.strip():
            continue
        if field in PATH_FIELDS:
            value = os.path.basename(value.rstrip("/\\")) or value
        elif field == "url":
            # Host only. A full URL is mostly query string, and that is where the
            # identifying parts of a link live.
            without_scheme = value.split("://", 1)[-1]
            value = without_scheme.split("/", 1)[0] or value
        return _shorten(value)
    return None


def options_path():
    return os.path.join(os.path.dirname(os.path.abspath(state_path())), "agent-avatar-options.json")


def activity_allowed():
    """On is a **choice the app writes down**; absent means off.

    🔴 **Default off, and the default has to live here too.** The skin defaults to not
    showing it; if this side defaulted to on, the tool names and file names would be
    written to disk anyway for every user who never asked for the feature — a switch
    that is off while the thing it switches keeps running.

    Gated here rather than in the skin for the same reason: with it off, nothing about
    the tool reaches disk at all. Costs one small read per event (usually ENOENT).

    The app re-asserts this file at every launch, because it lives in the temp
    directory and gets swept — without that, the feature would quietly stop working
    for someone who had turned it on.
    """
    return read_json(options_path(), {}).get("activity") is True


# The vocabulary has to cover both Hermes's tool names (terminal, exec_command,
# web_search) and Claude Code's (Bash, Grep, Glob, Read, Edit, Write, WebFetch, Agent).
RESEARCH_WORDS = ("search", "browser", "web", "fetch", "read", "lookup", "query", "grep", "glob")
EXECUTE_WORDS = ("terminal", "shell", "exec", "process", "command", "write", "edit", "patch", "build", "test", "compile", "file", "bash")
# These two groups used to share one SYNC_WORDS list, which showed "waiting on another
# agent" and "syncing Slack" as the same state. They are different things: in the first
# the parent session is idle-waiting, in the second an external-service tool is running.
DELEGATE_WORDS = ("delegate", "subagent", "agent")
SERVICE_WORDS = ("sync", "slack", "github", "drive", "notion", "calendar", "email", "teams")
AGENT_CLI_NAMES = frozenset({"codex", "claude"})
SHELL_NAMES = frozenset({"bash", "dash", "fish", "ksh", "sh", "zsh"})
COMMAND_WRAPPERS = frozenset({"command", "exec", "nohup", "time"})
ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


# ---------------------------------------------------------------------------
# Helpers (ported from star_office_hook.py; stdlib only)
# ---------------------------------------------------------------------------
def utc_timestamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def tool_state(name):
    value = str(name or "").lower()
    if any(word in value for word in DELEGATE_WORDS):
        return "awaiting"
    if any(word in value for word in SERVICE_WORDS):
        return "syncing"
    if any(word in value for word in RESEARCH_WORDS):
        return "researching"
    if any(word in value for word in EXECUTE_WORDS):
        return "executing"
    return "writing"


def command_invokes_agent_cli(command):
    """Recognize codex/claude in executable position without running a shell.

    Calling one of these hands the work to another agent and then waits — the same
    semantics as spawning a subagent (awaiting), and nothing to do with "syncing an
    external service"."""
    if isinstance(command, (list, tuple)):
        tokens = [str(item) for item in command]
    elif isinstance(command, str):
        try:
            lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()")
            lexer.whitespace_split = True
            lexer.commenters = ""
            tokens = list(lexer)
        except (TypeError, ValueError):
            return False
    else:
        return False

    expect_command = True
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token and all(character in ";&|()" for character in token):
            expect_command = True
            index += 1
            continue
        if not expect_command:
            index += 1
            continue
        if ASSIGNMENT_RE.match(token):
            index += 1
            continue

        executable = os.path.basename(token).lower()
        if executable in AGENT_CLI_NAMES:
            return True
        if executable in COMMAND_WRAPPERS:
            index += 1
            continue
        if executable == "env":
            index += 1
            while index < len(tokens):
                option = tokens[index]
                if ASSIGNMENT_RE.match(option):
                    index += 1
                elif option in ("-u", "--unset") and index + 1 < len(tokens):
                    index += 2
                elif option.startswith("-"):
                    index += 1
                else:
                    break
            continue
        # NOTE: privilege-elevation prefixes are deliberately NOT skipped here, and this
        # file must not name them. Hermes scans every plugin file with a plain
        # `\b`-anchored word regex and rates a hit HIGH "privilege_escalation" — a comment
        # counts. There is no waiver mechanism, so the only alternative was telling every
        # user to install with --force, i.e. teaching people to wave away a security
        # warning to install our thing. Not worth it for what it bought: an agent CLI
        # launched behind such a prefix is now read as "executing" instead of "awaiting".
        # See the commit that removed it for the full parser.
        if executable in SHELL_NAMES:
            for option_index in range(index + 1, min(len(tokens), index + 4)):
                if tokens[option_index] in ("-c", "-lc", "-cl") and option_index + 1 < len(tokens):
                    return command_invokes_agent_cli(tokens[option_index + 1])
            expect_command = False
            index += 1
            continue

        expect_command = False
        index += 1
    return False


def agent_cli_command(payload):
    """Read only the documented command field, including Hermes' extra envelope."""
    extra = payload.get("extra")
    for source in (payload, extra):
        if not isinstance(source, dict):
            continue
        tool_input = source.get("tool_input")
        if isinstance(tool_input, dict) and "command" in tool_input:
            return tool_input.get("command")
    return None


def explicit_child_id(payload):
    for key in ("child_session_id", "child_subagent_id"):
        if payload.get(key) is not None:
            return str(payload[key])
    extra = payload.get("extra")
    if isinstance(extra, dict):
        for key in ("child_session_id", "child_subagent_id"):
            if extra.get(key) is not None:
                return str(extra[key])
    return None


def explicit_correlation_id(payload):
    """Return only an ID supplied by the harness, never a synthesized fallback.

    `tool_use_id` is a field shared by Claude Code, Codex and Cursor (measured: CC
    2.1.212 carries it on both PreToolUse and PostToolUse). Missing it would drop every
    CC tool into the fallback pairing path that queues by tool name — and concurrent
    tools with the same name (common in CC) would then be paired wrongly.
    """
    for source in (payload, payload.get("extra")):
        if isinstance(source, dict):
            for key in ("tool_use_id", "tool_call_id", "call_id", "correlation_id", "id"):
                if source.get(key) is not None:
                    return str(source[key])
    return None


def normalized_tool_name(payload):
    """Key for the fallback pairing queue: with no call_id, pre/post are paired by
    queueing on the tool name."""
    extra = payload.get("extra")
    extra = extra if isinstance(extra, dict) else {}
    return str(payload.get("tool_name") or extra.get("tool_name") or "").strip().lower()


def has_error(payload):
    """AUTHORITATIVE failure: prefer the observer ``status`` field over re-deriving from result."""
    candidates = [payload.get("status")]
    extra = payload.get("extra")
    if isinstance(extra, dict):
        candidates += [extra.get("status")]
    explicit_statuses = [value.lower() for value in candidates if isinstance(value, str)]
    if explicit_statuses:
        return any(value in ("error", "failed", "failure") for value in explicit_statuses)
    if payload.get("error") or payload.get("is_error") is True or payload.get("success") is False:
        return True
    if isinstance(extra, dict):
        if extra.get("error") or extra.get("is_error") is True or extra.get("success") is False:
            return True
    result = payload.get("result")
    if result is None and isinstance(extra, dict):
        result = extra.get("result")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (TypeError, ValueError):
            result = None
    if isinstance(result, dict):
        if result.get("error") or result.get("is_error") is True or result.get("success") is False:
            return True
        exit_code = result.get("exit_code")
        if isinstance(exit_code, (int, float)) and not isinstance(exit_code, bool) and exit_code != 0:
            return True
        candidates += [result.get("status")]
    for value in candidates:
        if isinstance(value, str) and value.lower() in ("error", "failed", "failure"):
            return True
    return False


def session_id(payload, data=None):
    """Which session an event belongs to.

    When there is nothing to go on we fall back to `last_active` rather than the
    literal "default": on Hermes paths where `agent.session_id` is empty (the WebUI,
    for example) tool events arrive with an empty session_id, and bucketing them under
    "default" would file that turn's tools and its own pre_llm_call under two different
    sessions — after which the turn bookkeeping (llm_active / active_turns) no longer
    adds up. Attributing them to the previously active session is the correct answer.
    """
    extra = payload.get("extra")
    extra = extra if isinstance(extra, dict) else {}
    explicit = (payload.get("session_id") or payload.get("parent_session_id") or
                extra.get("session_id") or extra.get("parent_session_id"))
    if explicit:
        return str(explicit)
    inherited = data.get("last_active") if isinstance(data, dict) else None
    return str(inherited or "default")


def turn_id(payload):
    extra = payload.get("extra")
    extra = extra if isinstance(extra, dict) else {}
    return str(payload.get("turn_id") or extra.get("turn_id") or "")


def is_background_review_start(payload):
    message = payload.get("user_message")
    if message is None and isinstance(payload.get("extra"), dict):
        message = payload["extra"].get("user_message")
    return isinstance(message, str) and BACKGROUND_REVIEW_MARKER in message


# ---------------------------------------------------------------------------
# State machine (ported from star_office_hook.py)
# ---------------------------------------------------------------------------
def display_state(data):
    """Aggregate phase / tool kind / subagents of the **currently active session only**
    (`last_active`); never take a max across sessions.

    - Taking a max across sessions lets a leftover subagent in a stale or unrelated
      session push the display to syncing.
    - Do not fold turns[].review into reviewing: pre_llm_call already sets phase to
      reviewing when it sees a review, and folding again lets accumulated stale review
      turns override "thinking" (measured: five review turns wedged it permanently).
    - Expiry of the whole file is handled elsewhere — the Rust side's read_state_file
      has a 300 s fallback.
    """
    last_active = data.get("last_active")
    session = data.get("sessions", {}).get(last_active) if isinstance(data.get("sessions"), dict) else None
    if not session:
        return "idle"
    # Defensive: only tools whose owning turn is still alive count as busy. If leftover
    # `active` entries kept counting after a turn has finished (post_tool_call failed to
    # pop because the call_id did not match, or events arrived out of order), the skin
    # would wedge on executing forever. Tools inside a live turn are unaffected.
    turns = session.get("turns", {})
    active_turns = session.get("active_turns", {})
    states = [session.get("phase", "idle")]
    for call_id, state_of_call in session.get("active", {}).items():
        own_turn = active_turns.get(call_id)
        if own_turn and own_turn not in turns:
            continue
        states.append(state_of_call)
    # A running subagent means the parent session is waiting on another agent. That is
    # not "syncing an external service" — the two were deliberately split apart.
    states.extend("awaiting" for _ in session.get("subagents", []))
    return max(states or ["idle"], key=lambda item: PRIORITY.get(item, 0))


# What to do when a subagent stop carries an id we cannot match — **two harnesses want
# opposite behaviour, so this has to be a parameter**:
# - "dequeue-oldest" (Hermes): its subagent_stop sometimes has no child_session_id at
#   all, so a failure to match is our bookkeeping problem, not "it is still running".
#   Not dequeuing would leave an extra awaiting counted forever.
# - "ignore" (Claude Code): `/compact` emits an orphan SubagentStop whose id was never
#   announced and which has no matching start. Dequeuing would evict a subagent that is
#   genuinely running. Only handle the ones that match.
ORPHAN_DEQUEUE_OLDEST = "dequeue-oldest"
ORPHAN_IGNORE = "ignore"


def apply_event(data, payload, orphan_subagent_stop=ORPHAN_DEQUEUE_OLDEST):
    event = payload.get("hook_event_name")
    current_session_id = session_id(payload, data)
    sessions = data.setdefault("sessions", {})
    # A subagent runs its own conversation loop, and its pre_llm_call / pre_tool_call
    # carry **its own** session_id (`model_tools.py` emits hooks with the current agent's
    # session_id; only the subagent_start/stop emitted by delegate_tool carry
    # parent_session_id). Those events must not drive the avatar — otherwise one failing
    # tool inside a subagent pushes Echo into error while the parent session is fine.
    # The parent "has delegated" state is still recorded: that is the parent's real
    # state, and subagent_start below is what records it.
    subagent_sessions = data.setdefault("subagent_sessions", [])
    if current_session_id in subagent_sessions:
        # Nested delegation: when a subagent spawns its own subagent, that
        # subagent_start also belongs to an ignored session. We still have to record the
        # grandchild, otherwise its events leak through and steal last_active.
        if event == "subagent_start":
            grandchild = explicit_child_id(payload)
            if grandchild is not None and grandchild not in subagent_sessions:
                subagent_sessions.append(grandchild)
        return display_state(data)
    data["last_active"] = current_session_id
    if event == "on_session_start":
        sessions[current_session_id] = {"phase": "idle", "active": {}, "subagents": [], "turns": {}}
    session = sessions.setdefault(current_session_id, {
        "phase": "idle", "active": {}, "subagents": [], "turns": {},
    })
    session["updated_at"] = time.time()
    active = session.setdefault("active", {})
    subagents = session.setdefault("subagents", [])
    fallback_tools = session.setdefault("fallback_tools", {})
    background_reviews = session.setdefault("background_reviews", [])
    turns = session.setdefault("turns", {})
    active_turns = session.setdefault("active_turns", {})
    extra = payload.get("extra")
    extra = extra if isinstance(extra, dict) else {}

    if event == "on_session_start":
        active.clear(); subagents.clear()
        fallback_tools.clear(); background_reviews.clear(); turns.clear(); active_turns.clear()
    elif event == "pre_llm_call":
        current_turn_id = turn_id(payload)
        review = is_background_review_start(payload)
        # A new LLM turn starting means the previous turn's in-flight work is settled:
        # clear leftover active tools and accumulated turns, so that in a long session an
        # unpaired post_tool_call / post_llm_call cannot leave a stale state showing as
        # executing or thinking. Subagents are **not** cleared here — they legitimately
        # span turns, and keeping them is what makes the waiting state display correctly.
        active.clear(); turns.clear(); active_turns.clear(); background_reviews.clear()
        if current_turn_id:
            turns[current_turn_id] = {"llm_active": True, "review": review}
        if review:
            if current_turn_id and current_turn_id not in background_reviews:
                background_reviews.append(current_turn_id)
            session["phase"] = "reviewing"
        else:
            session["phase"] = "writing"
    elif event == "pre_tool_call":
        call_id = explicit_correlation_id(payload)
        if call_id is None:
            counter = int(session.get("fallback_counter", 0)) + 1
            session["fallback_counter"] = counter
            call_id = "fallback:%d" % counter
            fallback_tools.setdefault(normalized_tool_name(payload), []).append(call_id)
        active[call_id] = (
            "reviewing" if turns.get(turn_id(payload), {}).get("review")
            else "awaiting" if command_invokes_agent_cli(agent_cli_command(payload))
            else tool_state(payload.get("tool_name") or extra.get("tool_name"))
        )
        active_turns[call_id] = turn_id(payload)
        session["phase"] = "reviewing" if turns.get(turn_id(payload), {}).get("review") else "writing"
    elif event == "post_tool_call":
        call_id = explicit_correlation_id(payload)
        if call_id is not None:
            active.pop(call_id, None); active_turns.pop(call_id, None)
        else:
            queue = fallback_tools.get(normalized_tool_name(payload), [])
            if queue:
                finished_id = queue.pop(0)
                active.pop(finished_id, None); active_turns.pop(finished_id, None)
                if not queue:
                    fallback_tools.pop(normalized_tool_name(payload), None)
        # blocked reaction: Hermes uses status="blocked" to mean the tool was denied (not
        # an error). That must not put the turn into error — it emits a blocking reaction
        # and the turn continues. Reactions are an overlay; they do not change the base state.
        if (extra.get("status") or payload.get("status")) == "blocked":
            data["reaction_sequence"] = int(data.get("reaction_sequence", 0)) + 1
            data["reaction"] = {"kind": "blocked", "sequence": data["reaction_sequence"], "at": time.time()}
        session["phase"] = (
            "error" if has_error(payload)
            else "reviewing" if any(item.get("review") and item.get("llm_active") for item in turns.values())
            else "writing" if active or subagents or any(item.get("llm_active") for item in turns.values())
            else "idle"
        )
    elif event == "subagent_start":
        child_id = explicit_child_id(payload)
        if child_id is not None:
            # Record it as a session to ignore, and drop any record it may already have
            # created — on the Hermes side the subagent_start hook call is wrapped in
            # try/except, so when it is missed the subagent's own events arrive first.
            if child_id not in subagent_sessions:
                subagent_sessions.append(child_id)
            if child_id != current_session_id:
                sessions.pop(child_id, None)
        if child_id is None:
            counter = int(session.get("fallback_subagent_counter", 0)) + 1
            session["fallback_subagent_counter"] = counter
            child_id = "fallback-subagent:%d" % counter
        if child_id not in subagents:
            subagents.append(child_id)
        session["phase"] = "writing"
    elif event == "subagent_stop":
        child_id = explicit_child_id(payload)
        if child_id is not None and str(child_id) in subagents:
            subagents.remove(str(child_id))
        elif subagents and orphan_subagent_stop == ORPHAN_DEQUEUE_OLDEST:
            # Dequeue in arrival order: better to mismatch one than to leak one
            # (see the note on ORPHAN_DEQUEUE_OLDEST).
            if child_id is not None:
                diagnostic("stop for an untracked subagent; dequeuing the oldest")
            subagents.pop(0)
        if child_id is not None and str(child_id) != current_session_id:
            sessions.pop(str(child_id), None)
            if str(child_id) in subagent_sessions:
                subagent_sessions.remove(str(child_id))
        child_status = payload.get("child_status") or extra.get("child_status")
        failed = isinstance(child_status, str) and child_status.lower() in ("failed", "error", "interrupted")
        session["phase"] = "error" if failed or has_error(payload) else "writing"
    elif event in ("post_llm_call", "on_session_end"):
        current_turn_id = turn_id(payload)
        if event == "on_session_end":
            # ⚠️ `on_session_end` is a **turn-level** event, not the end of a session —
            # Hermes emits it as every run_conversation turn wraps up (the payload
            # carries turn_id / completed / failed / turn_exit_reason, which can only be
            # turn-level). The real session boundary is on_session_finalize. An earlier
            # comment here calling it "session end" was simply wrong.
            # Clearing subagents is still correct, but for a different reason: every
            # subagent this turn spawned is now settled. Without the clear, one missed
            # subagent_stop would wedge display_state on awaiting forever — pre_llm_call
            # deliberately does not clear subagents (they legitimately span turns), and
            # the Rust side's 300 s fallback looks at file mtime, which keeps refreshing
            # for as long as the user keeps talking, so it would never expire.
            background_reviews.clear(); turns.clear(); subagents.clear()
        else:
            if current_turn_id in background_reviews:
                background_reviews.remove(current_turn_id)
            if current_turn_id:
                turns.pop(current_turn_id, None)
        # Settle the finishing turn's in-flight tools too: the turn is over, so its tools
        # count as done whether or not post_tool_call's call_id matched. Otherwise the
        # leftover `active` entries wedge the skin on executing/writing forever — which is
        # exactly the bug when post_tool_call fails to pop because the call_id disagreed.
        if current_turn_id:
            stale_calls = [call_id for call_id, tid in list(active_turns.items()) if tid == current_turn_id]
            for stale_call in stale_calls:
                active.pop(stale_call, None); active_turns.pop(stale_call, None)
        # interrupted reaction: the user interrupted before the turn finished (Hermes sets
        # extra.interrupted=True). Emit a reaction; the base state is still computed from
        # the wrap-up event as usual (normally back to idle). Reactions are an overlay.
        if event == "on_session_end" and (extra.get("interrupted") or payload.get("interrupted")):
            data["reaction_sequence"] = int(data.get("reaction_sequence", 0)) + 1
            data["reaction"] = {"kind": "interrupted", "sequence": data["reaction_sequence"], "at": time.time()}
        # Turn-level failure: Hermes's on_session_end carries a boolean `failed`, and that
        # is **the authoritative verdict for this turn** — more reliable than inferring it
        # from post_tool_call statuses (every tool can succeed and the turn still fail).
        # `turn_exit_reason` is free text with an unknown vocabulary, so we do not guess.
        turn_failed = extra.get("failed") is True or payload.get("failed") is True
        session["phase"] = (
            "error" if turn_failed or has_error(payload)
            else "reviewing" if any(item.get("review") and item.get("llm_active") for item in turns.values())
            else "writing" if active or subagents or any(item.get("llm_active") for item in turns.values())
            else "idle"
        )
    elif event in ("on_session_finalize", "on_session_reset"):
        sessions.pop(current_session_id, None)
    else:
        raise ValueError("unsupported event")
    return display_state(data)


# ---------------------------------------------------------------------------
# Persisting the snapshot: atomic write plus a non-blocking lock
# ---------------------------------------------------------------------------
def diagnostic(message, harness=None):
    """Say something when things go wrong — **in both places**.

    stderr is for humans, but **nobody is reading it**: the dsh path sets the
    subprocess's stderr to `ignore` outright, and Claude Code / Codex only keep a line
    in their own error panels. So we also drop a file the app can read and turn into a
    reason the user can act on. This is **layer 2** of the three diagnostic layers
    (see private/RELEASE-CONNECTOR-WIZARD-DESIGN.md, "how failure becomes visible"):
    "it ran, but something went wrong".

    Layer 3 — the plugin never ran at all — is out of reach from here: not a line of
    this function executes in that case, and only the app can spot it from the outside
    ("installed, but has never reported").

    🔴 **This function must never raise.** It is called from an except branch, so
    blowing up here would promote "one event was ignored" into "the hook crashed".
    """
    print("agent-avatar-hook: " + message, file=sys.stderr)
    try:
        path = os.path.join(os.path.dirname(state_path(harness)),
                            "agent-avatar-diagnostic.%s.json" % (harness or "hermes"))
        atomic_write(path, {
            "at": utc_timestamp(),
            "harness": harness,
            "connector_version": CONNECTOR_VERSION,
            # The interpreter path is the single most useful field: on Windows,
            # "installed but nothing moves" is nine times out of ten the wrong one
            "python": sys.executable,
            "message": message,
        })
    except Exception:                      # noqa: BLE001 - see above: a diagnostic must never become the failure
        pass


# Each harness writes its own snapshot file, and the skin reads whichever one the
# "state source" setting points at. Running Hermes and Claude Code at the same time no
# longer makes them fight over a single file.
# Hermes keeps the original unsuffixed path — users who already had it working should
# not be broken by this change.
def state_path(harness=None):
    explicit = os.getenv("AGENT_AVATAR_STATE_PATH")
    if explicit:
        return explicit          # an explicit path is user intent; the naming rule does not apply
    name = "agent-avatar-state.json" if harness in (None, "hermes") else "agent-avatar-state.%s.json" % harness
    return os.path.join(tempfile.gettempdir(), name)


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as source:
            value = json.load(source)
        return value if isinstance(value, dict) else default
    except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
        return default


def atomic_write(path, value):
    """`os.replace` gives us atomicity, and that is enough — **no fsync**.

    This is a transient state file in `$TMPDIR`: after a power cut it is supposed to be
    gone anyway, so fsync buys nothing while costing a real disk round trip. And the
    Hermes plugin callback runs in-process with **no timeout**
    (`hermes_cli/plugins.py:2103` only wraps it in try/except), so every millisecond
    spent per event is added straight onto the agent's main loop.
    """
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".agent-avatar-state-", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, sort_keys=True)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


# Retry budget when the lock is contended. **It has to be bounded**: the Hermes plugin
# path is in-process with no timeout to fall back on (a shell hook at least has
# `timeout: 5`; the plugin has nothing), so a blocking flock would wedge the agent's
# main loop outright. One write is sub-millisecond today, so 0.5 s is room for a
# thousand retries; if we still cannot get the lock we drop the event — busy states
# expire on their own, and dropping one event is far better than stalling the user's agent.
LOCK_TIMEOUT_SECONDS = 0.5
LOCK_RETRY_SECONDS = 0.005


def acquire_lock(handle):
    """Try to take an exclusive lock. True if taken, False if held elsewhere, None if the
    platform offers nothing. **Never blocks.**

    The two platforms have different APIs but the semantics must match: non-blocking,
    exclusive, and **released by the kernel when the process exits**. That last property
    is why we use them instead of a "create a lock file" scheme — if a hook is killed,
    the lock-file approach leaves a lock nobody will ever release, while both of these
    are cleaned up by the OS.

    Windows uses `msvcrt.locking`: `LK_NBLCK` is exactly "non-blocking exclusive", the
    counterpart of flock's `LOCK_EX | LOCK_NB`. It locks a byte range rather than the
    whole file, so we agree to lock byte 0 — the lock file itself is empty, and Windows
    permits locking a range beyond EOF.
    """
    if fcntl is not None:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False
    if msvcrt is not None:
        try:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    return None


def release_lock(handle):
    """Release explicitly. Closing the file would release it anyway, but saying so is
    clearer and avoids depending on when the close happens."""
    try:
        if fcntl is not None:
            fcntl.flock(handle, fcntl.LOCK_UN)
        elif msvcrt is not None:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:  # pragma: no cover - if unlocking fails the file is about to close and the kernel cleans up
        pass


def update(payload, label, audio=None, orphan_subagent_stop=ORPHAN_DEQUEUE_OLDEST, harness=None):
    """Run one event through the state machine and persist the result.

    `label`: the subject written into `detail` ("Hermes", "Claude Code", ...).
    `audio`: the audio block this harness wants to pass along; `None` means keep the
             previous value rather than overwrite it.
    `harness`: decides which snapshot file is written (see `state_path`).
    """
    path = state_path(harness)
    sessions_path = path + ".sessions"
    default_sessions = {"schema_version": STATE_SCHEMA_VERSION, "sessions": {}}

    def transition():
        data = read_json(sessions_path, default_sessions)
        if data.get("schema_version") != STATE_SCHEMA_VERSION:
            data = default_sessions.copy()
            data["sessions"] = {}
        apply_event(data, payload, orphan_subagent_stop)
        state = display_state(data)
        previous = read_json(path, {})
        sequence = previous.get("sequence", 0)
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
            sequence = 0
        # 只在忙的时候**产生**详情：writing 本来就没有工具在跑。error 带上，因为那时候
        # 「是哪个工具错了」正是唯一想知道的事。
        # 产生之后它会多活 DOING_HOLD_SECONDS（见下），否则短工具的详情根本来不及被看见；
        # 「idle 还挂着一句 npm test 像卡住了」由那个过期时间挡住，而不是靠立刻抹掉。
        doing = activity_from(payload) if state in ACTIVITY_STATES and activity_allowed() else None
        snapshot = {
            "state": state,
            "detail": detail_for(state, label),
            "sequence": sequence + 1,
            "updated_at": utc_timestamp(),
            "connector_version": CONNECTOR_VERSION,
        }
        # Reactions are an overlay: carry a recent one (inside the time window) out of
        # `data`, and the skin fires it once, deduplicated by `at`.
        # The dedup key is `at` rather than `sequence` because sequence lives in the
        # volatile .sessions file: once that is rebuilt (schema change, TMPDIR cleanup)
        # it restarts at 1, and the skin would drop the next reaction as already seen.
        reaction = data.get("reaction")
        if isinstance(reaction, dict) and reaction.get("kind"):
            at = float(reaction.get("at", 0) or 0)
            held_for = time.time() - at
            if held_for <= REACTION_HOLD_SECONDS:
                snapshot["reaction"] = {"kind": reaction["kind"], "sequence": int(reaction.get("sequence", 0)), "at": at}
            else:
                data.pop("reaction", None)
        if doing:
            snapshot["doing"] = doing
            snapshot["doing_until"] = time.time() + DOING_HOLD_SECONDS
        else:
            # 这一条没有详情（idle/writing，或者字段不在白名单里）—— 把上一条还没过期的
            # 带过来，否则一次工具调用的详情会在几十毫秒内被下一个事件抹掉。
            until = previous.get("doing_until")
            if isinstance(until, (int, float)) and not isinstance(until, bool) \
                    and time.time() < until and isinstance(previous.get("doing"), str):
                snapshot["doing"] = previous["doing"]
                snapshot["doing_until"] = float(until)
        carried = audio if audio else previous.get("audio")
        if isinstance(carried, dict) and carried:
            snapshot["audio"] = carried
        atomic_write(sessions_path, data)
        atomic_write(path, snapshot)

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    # This used to read `if fcntl is None: write without a lock`. fcntl does not exist on
    # Windows, so the entire Windows path **silently degraded to an unlocked
    # read-modify-write** — parallel tool calls and subagents start several hook
    # processes at once, all racing for the same .sessions file and overwriting each
    # other. What gets lost is bookkeeping, so the state machine computes a wrong state
    # and the avatar wedges, with no error anywhere. Both platforms now have a real lock;
    # see acquire_lock.
    with open(path + ".lock", "a+", encoding="utf-8") as lock:
        deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
        while True:
            acquired = acquire_lock(lock)
            if acquired is None:
                # Neither fcntl nor msvcrt. We only support macOS and Windows, and each
                # has one of them, so this is unreachable in practice — but if we ever get
                # here, say so out loud instead of silently degrading again.
                diagnostic("no cross-process lock on this platform; writing unserialised")
                transition()
                return
            if acquired:
                break
            if time.monotonic() >= deadline:
                diagnostic("state file busy; dropping this event")
                return
            time.sleep(LOCK_RETRY_SECONDS)
        try:
            transition()
        finally:
            release_lock(lock)
