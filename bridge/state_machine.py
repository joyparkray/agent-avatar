#!/usr/bin/env python3
"""Agent Avatar 的共用语义状态机（stdlib only，harness 无关）。

**内部事件词表**沿用 Hermes 的事件名（`pre_llm_call` / `pre_tool_call` / ...）——
它是历史形成的，不是对 Hermes 的依赖。每个 harness 的适配层负责把自家的事件名翻译
成这套词表，状态机本身不认识任何具体 harness。见 `docs/DESIGN-M3-MULTI-HARNESS.md` §3.1。

状态机（`apply_event` / `display_state` / 分类辅助函数）移植自
`Star-Office-UI-Hermes/integrations/hermes/star_office_hook.py`（MIT）。
HTTP 上报（`push`）与 Star Office 的投递编排**没有**移植 —— Agent Avatar 只消费聚合后的基态，
词表是 `docs/HERMES-STATE-TAXONOMY.md` 里的 8 基态契约。
"""

try:
    import fcntl
except ImportError:  # pragma: no cover - platform-specific fallback
    fcntl = None

import json
import os
import re
import shlex
import sys
import tempfile
import time
from datetime import datetime, timezone

STATE_SCHEMA_VERSION = 2
# reaction 信号在快照里保留多久：皮肤以 200ms 轮询，2s 足够它读到并去重（按 at）触发一次。
REACTION_HOLD_SECONDS = 2.0
BACKGROUND_REVIEW_MARKER = (
    "You can only call memory and skill management tools. "
    "Other tools will be denied at runtime"
)

# 优先级 = 并发信号里显示哪个。
# - reviewing 低于 writing：它是 turn 结束后的后台整理，用户一旦又说话，当前对话更该被看见。
# - awaiting 最高（除 error）：整个 turn 都卡在等别人身上，比自己在跑的任何工具更有代表性。
PRIORITY = {"idle": 0, "reviewing": 1, "writing": 2, "researching": 3,
            "executing": 4, "syncing": 5, "awaiting": 6, "error": 7}
# 主语由适配层传入（"Hermes" / "Claude Code"）—— 硬编码 "Hermes" 会让别家 harness 的
# 用户看到 "Hermes is running a tool"。
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


# 词表要同时覆盖 Hermes 的工具名（terminal / exec_command / web_search）与
# Claude Code 的（Bash / Grep / Glob / Read / Edit / Write / WebFetch / Agent）。
RESEARCH_WORDS = ("search", "browser", "web", "fetch", "read", "lookup", "query", "grep", "glob")
EXECUTE_WORDS = ("terminal", "shell", "exec", "process", "command", "write", "edit", "patch", "build", "test", "compile", "file", "bash")
# 原来这两组挤在一个 SYNC_WORDS 里，于是「等另一个 agent」和「同步 Slack」显示成同一个状态。
# 它们是两件事：前者父会话在干等，后者只是一个外部服务工具在跑。
DELEGATE_WORDS = ("delegate", "subagent", "agent")
SERVICE_WORDS = ("sync", "slack", "github", "drive", "notion", "calendar", "email", "teams")
AGENT_CLI_NAMES = frozenset({"codex", "claude"})
SHELL_NAMES = frozenset({"bash", "dash", "fish", "ksh", "sh", "zsh"})
COMMAND_WRAPPERS = frozenset({"command", "exec", "nohup", "time"})
SUDO_OPTIONS_WITH_VALUE = frozenset({
    "-C", "--close-from", "-D", "--chdir", "-g", "--group",
    "-h", "--host", "-p", "--prompt", "-R", "--chroot",
    "-T", "--command-timeout", "-u", "--user",
})
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

    调它们等于把活交给另一个 agent 然后干等 —— 与派子代理同一语义（awaiting），
    和「同步外部服务」（syncing）无关。"""
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
        if executable == "sudo":
            index += 1
            while index < len(tokens):
                option = tokens[index]
                if option == "--":
                    index += 1
                    break
                if option in SUDO_OPTIONS_WITH_VALUE and index + 1 < len(tokens):
                    index += 2
                elif option.startswith("-"):
                    index += 1
                else:
                    break
            continue
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

    `tool_use_id` 是 Claude Code / Codex / Cursor 三家的公共字段（实测 CC 2.1.212 的
    PreToolUse/PostToolUse 都带），漏掉它会让 CC 的每个工具都掉进按工具名排队的
    fallback 配对路径 —— 并发同名工具（CC 很常见）就会配错。
    """
    for source in (payload, payload.get("extra")):
        if isinstance(source, dict):
            for key in ("tool_use_id", "tool_call_id", "call_id", "correlation_id", "id"):
                if source.get(key) is not None:
                    return str(source[key])
    return None


def normalized_tool_name(payload):
    """fallback 配对队列的键：没有 call_id 时按工具名把 pre/post 排队配对。"""
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
    """事件的归属会话。

    拿不到时回落到 `last_active` 而不是字面量 "default"：Hermes 的工具事件在
    `agent.session_id` 为空的路径（如 WebUI）下 session_id 会是空串，
    落进一个 "default" 桶会把该 turn 的工具与它自己的 pre_llm_call 记到两个会话里，
    turn 记账（llm_active / active_turns）随即对不上。归给上一个活跃会话才是对的。
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
    """只聚合当前活跃会话（last_active）的 phase / 工具kind / 子代理，不跨会话取 max。

    - 跨会话取 max 会被 stale/无关会话的残留 subagent 顶成 syncing。
    - 不累加 turns[].review → reviewing：pre_llm_call 遇 review 时已把 phase 置为 reviewing，
      这里再累加会让「思考」被累计的 stale review turn 顶掉（实测 5 个 review turn 挂死）。
    - 全文件过期回落由 Rust 侧 read_state_file 的 300s 兜底负责。
    """
    last_active = data.get("last_active")
    session = data.get("sessions", {}).get(last_active) if isinstance(data.get("sessions"), dict) else None
    if not session:
        return "idle"
    # 防御：只把「所属 turn 仍存活」的工具算作忙态。turn 已收尾（post_tool_call 因 call_id
    # 对不上漏 pop、或事件乱序）后残留的 active 条目若继续计入，皮肤会永久卡 executing。
    # 正常在 turn 内的工具不受影响（其 turn 仍存活）。
    turns = session.get("turns", {})
    active_turns = session.get("active_turns", {})
    states = [session.get("phase", "idle")]
    for call_id, state_of_call in session.get("active", {}).items():
        own_turn = active_turns.get(call_id)
        if own_turn and own_turn not in turns:
            continue
        states.append(state_of_call)
    # 有子代理在跑 = 父会话在等另一个 agent。这不是「同步外部服务」，两者已拆开。
    states.extend("awaiting" for _ in session.get("subagents", []))
    return max(states or ["idle"], key=lambda item: PRIORITY.get(item, 0))


# 子代理 stop 的 ID 配不上时怎么办 —— **两家 harness 要求相反，必须参数化**：
# - "dequeue-oldest"（Hermes）：它的 subagent_stop 有时拿不到 child_session_id，
#   配不上是我们的记账问题而不是「它还在跑」。不出队会永久多算一个 awaiting。
# - "ignore"（Claude Code）：`/compact` 会发一条 ID 从没出现过、也没有对应 start 的
#   孤儿 SubagentStop。出队会踢掉一个真正在跑的子代理。只处理配得上的。
ORPHAN_DEQUEUE_OLDEST = "dequeue-oldest"
ORPHAN_IGNORE = "ignore"


def apply_event(data, payload, orphan_subagent_stop=ORPHAN_DEQUEUE_OLDEST):
    event = payload.get("hook_event_name")
    current_session_id = session_id(payload, data)
    sessions = data.setdefault("sessions", {})
    # 子代理跑自己的 conversation loop，它的 pre_llm_call / pre_tool_call 带的是**它自己的**
    # session_id（`model_tools.py` 用当前 agent 的 session_id 发 hook；只有 delegate_tool 发的
    # subagent_start/stop 才带 parent_session_id）。这些事件不该驱动形象 —— 否则子代理的一个
    # 工具报错会把 Echo 顶成 error，而父会话其实好好的。
    # 父会话「派了子代理」仍记成 syncing：那是父会话真实的状态，由下面的 subagent_start 负责。
    subagent_sessions = data.setdefault("subagent_sessions", [])
    if current_session_id in subagent_sessions:
        # 嵌套委派：子代理再派子代理时，那条 subagent_start 也归属被忽略的会话。
        # 仍要登记孙代理，否则它的事件会漏进来接着夺 last_active。
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
        # 新 LLM turn 开始 = 上一轮的 in-flight 已过账：清掉残留的 active 工具与累计 turns，
        # 防止长会话里漏配对的 post_tool_call / post_llm_call 把 stale 状态顶成执行中/思考中。
        # 子代理不在此清（跨 turn 合法存在，且保留能正确显示 syncing）。
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
        # blocked 反应：Hermes 用 status="blocked" 表示工具被拒（not error）。它不该把 turn 判成
        # error，而是发一条 blocking reaction + 继续当前 turn。reaction 是叠加层，不影响基态。
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
            # 登记成「要忽略的会话」，并清掉它在此之前可能已建的记录 —— subagent_start 的 hook
            # 调用在 Hermes 侧是 try/except 包着的，漏发时子代理的事件会先到。
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
            # 按到达顺序出队，宁可配错一个也不泄漏（见 ORPHAN_DEQUEUE_OLDEST 的说明）。
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
            # ⚠️ `on_session_end` 是 **turn 级**事件，不是会话结束 —— Hermes 在每个
            # run_conversation turn 收尾时都发它（payload 带 turn_id / completed /
            # failed / turn_exit_reason，只可能是 turn 级）。真正的会话边界是
            # on_session_finalize。原注释把它当会话结束是错的。
            # 清子代理仍然正确，但理由是「该 turn 派出的子代理都已收束」：不清的话，
            # 漏发的 subagent_stop 会让 display_state 永久停在 awaiting —— pre_llm_call
            # 不清子代理（跨 turn 合法），Rust 的 300s 兜底又看文件 mtime，用户继续
            # 说话就一直刷新，永远过不了期。
            background_reviews.clear(); turns.clear(); subagents.clear()
        else:
            if current_turn_id in background_reviews:
                background_reviews.remove(current_turn_id)
            if current_turn_id:
                turns.pop(current_turn_id, None)
        # 收尾 turn 的 in-flight 工具一并结清：turn 已结束，它旗下的工具无论 post_tool_call
        # 的 call_id 是否配对成功都算完成，否则残留 active 会让皮肤永久卡 executing/writing
        # （post_tool_call 因 call_id 对不上 pop 失败即此 bug）。
        if current_turn_id:
            stale_calls = [call_id for call_id, tid in list(active_turns.items()) if tid == current_turn_id]
            for stale_call in stale_calls:
                active.pop(stale_call, None); active_turns.pop(stale_call, None)
        # interrupted 反应：用户在 turn 结束前打断（Hermes 用 extra.interrupted=True）。发一条反应，
        # 基态照常按收尾事件计算（通常回 idle）。reaction 是叠加层，不影响基态。
        if event == "on_session_end" and (extra.get("interrupted") or payload.get("interrupted")):
            data["reaction_sequence"] = int(data.get("reaction_sequence", 0)) + 1
            data["reaction"] = {"kind": "interrupted", "sequence": data["reaction_sequence"], "at": time.time()}
        # turn 级失败：Hermes 的 on_session_end 带一个布尔 `failed`，那是**这一轮的权威
        # 结论**，比从 post_tool_call 的 status 反推准（工具全成功、turn 仍可能失败）。
        # `turn_exit_reason` 是自由文本，词表未知，不去猜。
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
# 快照落盘：原子写 + 非阻塞锁
# ---------------------------------------------------------------------------
def diagnostic(message):
    print("agent-avatar-hook: " + message, file=sys.stderr)


# 每个 harness 写自己的快照文件，皮肤按「状态来源」设置读其中一个。
# 同时开着 Hermes 和 Claude Code 时不再互相抢同一个文件。
# Hermes 沿用无后缀的老路径 —— 已经装好的用户不该因为这次改动就断掉。
def state_path(harness=None):
    explicit = os.getenv("AGENT_AVATAR_STATE_PATH")
    if explicit:
        return explicit          # 显式指定是用户意图，不参与命名规则
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
    """`os.replace` 保证原子性即可，**不做 fsync**。

    这是 `$TMPDIR` 里的瞬态状态文件：掉电后它本来就该是空的，fsync 换不来任何东西，
    却要付一次真实的磁盘往返。而 Hermes 插件的回调是 in-process 且**没有超时**
    （`hermes_cli/plugins.py:2103` 只包了 try/except），每个事件多花的毫秒都直接
    加在 agent 主循环上。
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


# 拿不到锁时的重试上限。**必须有界**：Hermes 插件路径是 in-process 且没有超时兜底
# （shell hook 还有 `timeout: 5`，插件什么都没有），阻塞式 flock 会把 agent 主循环
# 直接卡住。写一次现在是亚毫秒级，0.5s 足够重试上千次；真拿不到就丢弃这个事件 ——
# 忙态有过期兜底，丢一个事件远好过卡住用户的 agent。
LOCK_TIMEOUT_SECONDS = 0.5
LOCK_RETRY_SECONDS = 0.005


def update(payload, label, audio=None, orphan_subagent_stop=ORPHAN_DEQUEUE_OLDEST, harness=None):
    """把一个事件过一遍状态机并落盘。

    `label`：写进 `detail` 的主语（"Hermes" / "Claude Code"）。
    `audio`：该 harness 要额外带出的音频块；`None` 表示沿用上一次的值（不覆盖）。
    `harness`：决定写哪个快照文件（见 `state_path`）。
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
        snapshot = {
            "state": state,
            "detail": detail_for(state, label),
            "sequence": sequence + 1,
            "updated_at": utc_timestamp(),
        }
        # reaction 是叠加层：从 data 里带出近期的 reaction（时间窗内），皮肤按 at 去重触发一次。
        # 去重键是 `at` 而不是 `sequence`：sequence 存在易失的 .sessions 里，文件被重建
        # （schema 变更 / TMPDIR 清理）后它从 1 重新开始，皮肤会把下一条反应当成已见过的丢掉。
        reaction = data.get("reaction")
        if isinstance(reaction, dict) and reaction.get("kind"):
            at = float(reaction.get("at", 0) or 0)
            held_for = time.time() - at
            if held_for <= REACTION_HOLD_SECONDS:
                snapshot["reaction"] = {"kind": reaction["kind"], "sequence": int(reaction.get("sequence", 0)), "at": at}
            else:
                data.pop("reaction", None)
        carried = audio if audio else previous.get("audio")
        if isinstance(carried, dict) and carried:
            snapshot["audio"] = carried
        atomic_write(sessions_path, data)
        atomic_write(path, snapshot)

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if fcntl is None:
        diagnostic("cross-process locking unavailable; writing without a lock")
        transition()
        return
    with open(path + ".lock", "a+", encoding="utf-8") as lock:
        deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    diagnostic("state file busy; dropping this event")
                    return
                time.sleep(LOCK_RETRY_SECONDS)
        transition()
