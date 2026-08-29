"""Claude Code 适配层测试。

主用例重放的是**实机抓取的真实事件序列**（Claude Code 2.1.212，macOS，
隔离 --settings 取样器；见 docs/DESIGN-M3-MULTI-HARNESS.md §2.6），
不是照文档编的合成数据。
"""

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).with_name("agent-avatar-hook.py")
SESSION = "sess-1"


def invoke(path, payload):
    env = {k: v for k, v in os.environ.items()}
    env["AGENT_AVATAR_STATE_PATH"] = str(path)
    return subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(payload),
                          text=True, capture_output=True, env=env, check=False)


def send(path, event, **fields):
    fields.setdefault("session_id", SESSION)
    result = invoke(path, dict(hook_event_name=event, **fields))
    # 🔴 观察者绝不能返回 2：CC 会把它当 block（Stop 被 block = 对话停不下来）
    assert result.returncode == 0, result.stderr
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return {}


def test_real_captured_session_drives_the_right_states(tmp_path):
    """实机序列：Bash 工具 → Agent 子代理 → 收尾。"""
    p = tmp_path / "state.json"
    T = "prompt-1"

    assert send(p, "SessionStart", source="startup")["state"] == "idle"
    assert send(p, "UserPromptSubmit", prompt_id=T)["state"] == "writing"
    assert send(p, "PreToolUse", prompt_id=T, tool_name="Bash",
                tool_input={"command": "echo one"}, tool_use_id="u1")["state"] == "executing"
    # 工具收尾后**不能掉回 idle** —— 回合还活着（靠 prompt_id 记账）。
    # 这正是「CC 没有 turn_id」那个误判会导致的表情抖动。
    assert send(p, "PostToolUse", prompt_id=T, tool_name="Bash", tool_use_id="u1")["state"] == "writing"

    # Agent 工具本身就分类成 awaiting，子代理生命周期把它撑住
    assert send(p, "PreToolUse", prompt_id=T, tool_name="Agent",
                tool_input={}, tool_use_id="u2")["state"] == "awaiting"
    assert send(p, "SubagentStart", prompt_id=T, agent_id="A1", agent_type="Explore")["state"] == "awaiting"
    assert send(p, "SubagentStop", prompt_id=T, agent_id="A1", agent_type="Explore")["state"] == "awaiting"
    assert send(p, "PostToolUse", prompt_id=T, tool_name="Agent", tool_use_id="u2")["state"] == "writing"
    assert send(p, "Stop", prompt_id=T)["state"] == "idle"


def test_subagent_internal_events_never_drive_the_avatar(tmp_path):
    """子代理内部的事件带 agent_id，且带的是**父会话的** session_id（实测确认）。

    不过滤的话，子代理的一个工具报错会把 Echo 顶成 error 而父会话好好的。
    """
    p = tmp_path / "state.json"
    T = "prompt-1"
    send(p, "UserPromptSubmit", prompt_id=T)
    send(p, "PreToolUse", prompt_id=T, tool_name="Agent", tool_input={}, tool_use_id="u1")
    send(p, "SubagentStart", prompt_id=T, agent_id="A1", agent_type="Explore")
    before = json.loads(p.read_text())["sequence"]

    # 子代理自己的工具失败：一个字节都不该写
    send(p, "PostToolUseFailure", prompt_id=T, agent_id="A1", agent_type="Explore",
         tool_name="Bash", tool_use_id="child-1")
    after = json.loads(p.read_text())
    assert after["sequence"] == before, "子代理内部事件不该驱动形象"
    assert after["state"] == "awaiting"


def test_resume_and_compact_must_not_wipe_live_state(tmp_path):
    """`--continue` 与 `/compact` 都会再发一条 SessionStart —— 那是同一局的延续。

    当成全量重置会把还活着的子代理和在跑的工具清掉。
    """
    p = tmp_path / "state.json"
    T = "prompt-1"
    send(p, "UserPromptSubmit", prompt_id=T)
    send(p, "PreToolUse", prompt_id=T, tool_name="Bash", tool_input={}, tool_use_id="u1")
    assert json.loads(p.read_text())["state"] == "executing"
    for source in ("resume", "compact", "fork"):
        assert send(p, "SessionStart", source=source)["state"] == "executing", source
    # startup / clear 才是开新局
    assert send(p, "SessionStart", source="clear")["state"] == "idle"


def test_orphan_subagent_stop_is_ignored_not_dequeued(tmp_path):
    """`/compact` 会发一条 ID 从没出现过、也没有对应 start 的孤儿 SubagentStop。

    Hermes 的「配不上就出队最老」在这里会踢掉一个真正在跑的子代理 —— 两家要求相反。
    """
    p = tmp_path / "state.json"
    T = "prompt-1"
    send(p, "UserPromptSubmit", prompt_id=T)
    send(p, "SubagentStart", prompt_id=T, agent_id="A1")
    assert json.loads(p.read_text())["state"] == "awaiting"
    send(p, "SubagentStop", prompt_id=T, agent_id="GHOST")     # 孤儿
    assert json.loads(p.read_text())["state"] == "awaiting", "活着的子代理被孤儿 stop 踢掉了"
    send(p, "SubagentStop", prompt_id=T, agent_id="A1")        # 真正的那条
    assert json.loads(p.read_text())["state"] == "writing"


def test_tool_failure_and_permission_denied(tmp_path):
    p = tmp_path / "state.json"
    T = "prompt-1"
    send(p, "UserPromptSubmit", prompt_id=T)
    send(p, "PreToolUse", prompt_id=T, tool_name="Bash", tool_input={}, tool_use_id="u1")
    assert send(p, "PostToolUseFailure", prompt_id=T, tool_name="Bash",
                tool_use_id="u1")["state"] == "error"

    send(p, "PreToolUse", prompt_id=T, tool_name="Bash", tool_input={}, tool_use_id="u2")
    snapshot = send(p, "PermissionDenied", prompt_id=T, tool_name="Bash", tool_use_id="u2")
    assert snapshot["reaction"]["kind"] == "blocked"      # 叠加层
    assert snapshot["state"] != "error"                   # 基态不受影响


def test_stop_hook_active_is_not_a_turn_end(tmp_path):
    """别的 hook 阻止了停止 → 这条 Stop 是续跑，不是回合结束。"""
    p = tmp_path / "state.json"
    T = "prompt-1"
    send(p, "UserPromptSubmit", prompt_id=T)
    assert send(p, "Stop", prompt_id=T, stop_hook_active=True)["state"] == "writing"
    assert send(p, "Stop", prompt_id=T)["state"] == "idle"


def test_a_new_turn_gets_a_new_prompt_id(tmp_path):
    """实测 prompt_id 每轮变化、session_id 不变 —— 它就是 CC 的 turn id。"""
    p = tmp_path / "state.json"
    send(p, "UserPromptSubmit", prompt_id="prompt-1")
    send(p, "PreToolUse", prompt_id="prompt-1", tool_name="Bash", tool_input={}, tool_use_id="u1")
    send(p, "Stop", prompt_id="prompt-1")
    assert json.loads(p.read_text())["state"] == "idle"
    assert send(p, "UserPromptSubmit", prompt_id="prompt-2")["state"] == "writing"


def test_tool_names_classify_the_claude_code_way(tmp_path):
    """CC 的工具名和 Hermes 的不同，词表要同时覆盖。"""
    expected = {"Bash": "executing", "Edit": "executing", "Write": "executing",
                "Read": "researching", "Grep": "researching", "Glob": "researching",
                "WebFetch": "researching", "WebSearch": "researching", "Agent": "awaiting"}
    for tool, state in expected.items():
        p = tmp_path / f"state-{tool}.json"
        send(p, "UserPromptSubmit", prompt_id="t")
        assert send(p, "PreToolUse", prompt_id="t", tool_name=tool, tool_input={},
                    tool_use_id="u")["state"] == state, tool


def test_unmapped_and_blocking_events_are_never_touched(tmp_path):
    """白名单：映射表外的事件一律忽略，尤其是 exit-2 可阻塞的那些。"""
    p = tmp_path / "state.json"
    send(p, "UserPromptSubmit", prompt_id="t")
    before = json.loads(p.read_text())["sequence"]
    for event in ("PermissionRequest", "WorktreeCreate", "PreCompact", "PostToolBatch",
                  "Notification", "TaskCreated", "TeammateIdle"):
        result = invoke(p, {"hook_event_name": event, "session_id": SESSION, "prompt_id": "t"})
        assert result.returncode == 0
    assert json.loads(p.read_text())["sequence"] == before


def test_garbage_input_still_exits_zero(tmp_path):
    """exit 2 在 CC 上会拦工具 / 让对话停不下来。任何输入都必须 exit 0。"""
    for bad in ("", "not json", "[]", '{"hook_event_name": 123}'):
        assert invoke(tmp_path / "state.json", bad if isinstance(bad, str) else bad).returncode == 0
