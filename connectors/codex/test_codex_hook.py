"""Codex 适配层测试 —— 重点覆盖它与 Claude Code 的三处差异。

契约来源：官方 hooks 文档（learn.chatgpt.com/docs/hooks）。
Codex 与 CC 高度同构，共用 `core/pascal_events.py`；本文件只测差异与关键不变量。
"""

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).with_name("agent-avatar-hook.py")
S = "codex-sess"


def invoke(path, payload):
    env = dict(os.environ)
    env["AGENT_AVATAR_STATE_PATH"] = str(path)
    return subprocess.run([sys.executable, str(SCRIPT)],
                          input=payload if isinstance(payload, str) else json.dumps(payload),
                          text=True, capture_output=True, env=env, check=False)


def send(path, event, **fields):
    fields.setdefault("session_id", S)
    result = invoke(path, dict(hook_event_name=event, **fields))
    # 🔴 Codex 的 exit 2 阻塞范围比 CC 还大（连 PostToolUse 都算），绝不能返回 2
    assert result.returncode == 0, result.stderr
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def test_full_turn_with_subagent(tmp_path):
    """Codex **有**子代理事件（设计稿原先写「没有」是错的），且 turn_id 是显式字段。"""
    p, T = tmp_path / "s.json", "turn-1"
    assert send(p, "SessionStart", source="startup")["state"] == "idle"
    assert send(p, "UserPromptSubmit", turn_id=T)["state"] == "writing"
    assert send(p, "PreToolUse", turn_id=T, tool_name="shell",
                tool_input={"command": "ls"}, tool_use_id="u1")["state"] == "executing"
    # 工具收尾后回合还活着，不能掉回 idle
    assert send(p, "PostToolUse", turn_id=T, tool_name="shell", tool_use_id="u1")["state"] == "writing"
    assert send(p, "SubagentStart", turn_id=T, agent_id="A1", agent_type="explore")["state"] == "awaiting"
    assert send(p, "SubagentStop", turn_id=T, agent_id="A1", agent_type="explore")["state"] == "writing"
    assert send(p, "Stop", turn_id=T)["state"] == "idle"


def test_turn_id_is_the_turn_field_not_prompt_id(tmp_path):
    """Codex 用 turn_id，CC 用 prompt_id —— 拿错字段会让 turn 记账全空、工具间闪 idle。"""
    p = tmp_path / "s.json"
    send(p, "UserPromptSubmit", turn_id="t1")
    send(p, "PreToolUse", turn_id="t1", tool_name="shell", tool_input={}, tool_use_id="u1")
    # 收尾后仍是 writing 就证明 turn 记账生效了
    assert send(p, "PostToolUse", turn_id="t1", tool_name="shell", tool_use_id="u1")["state"] == "writing"
    assert send(p, "Stop", turn_id="t1")["state"] == "idle"


def test_error_is_derived_from_tool_response(tmp_path):
    """Codex 没有 PostToolUseFailure —— 错误只能从 tool_response 反推。"""
    p, T = tmp_path / "s.json", "t1"
    send(p, "UserPromptSubmit", turn_id=T)
    send(p, "PreToolUse", turn_id=T, tool_name="shell", tool_input={}, tool_use_id="u1")
    snapshot = send(p, "PostToolUse", turn_id=T, tool_name="shell", tool_use_id="u1",
                    tool_response=json.dumps({"exit_code": 1, "output": "boom"}))
    assert snapshot["state"] == "error"


def test_a_successful_tool_response_is_not_an_error(tmp_path):
    p, T = tmp_path / "s.json", "t1"
    send(p, "UserPromptSubmit", turn_id=T)
    send(p, "PreToolUse", turn_id=T, tool_name="shell", tool_input={}, tool_use_id="u1")
    snapshot = send(p, "PostToolUse", turn_id=T, tool_name="shell", tool_use_id="u1",
                    tool_response=json.dumps({"exit_code": 0, "output": "ok"}))
    assert snapshot["state"] == "writing"


def test_permission_request_is_never_acted_on(tmp_path):
    """PermissionRequest 是**阻塞式决策 hook**。我们既不注册也不处理 —— 就算收到也必须无副作用。"""
    p = tmp_path / "s.json"
    send(p, "UserPromptSubmit", turn_id="t1")
    before = json.loads(p.read_text(encoding="utf-8"))["sequence"]
    result = invoke(p, {"hook_event_name": "PermissionRequest", "session_id": S,
                        "turn_id": "t1", "tool_name": "shell", "tool_input": {}})
    assert result.returncode == 0
    assert result.stdout == "", "绝不能往 stdout 写东西 —— 那会被解释成决策"
    assert json.loads(p.read_text(encoding="utf-8"))["sequence"] == before


def test_subagent_internal_events_never_drive_the_avatar(tmp_path):
    p, T = tmp_path / "s.json", "t1"
    send(p, "UserPromptSubmit", turn_id=T)
    send(p, "SubagentStart", turn_id=T, agent_id="A1")
    before = json.loads(p.read_text(encoding="utf-8"))["sequence"]
    send(p, "PostToolUse", turn_id=T, agent_id="A1", agent_type="explore",
         tool_name="shell", tool_use_id="c1", tool_response='{"exit_code":1}')
    after = json.loads(p.read_text(encoding="utf-8"))
    assert after["sequence"] == before, "子代理内部事件不该驱动形象"
    assert after["state"] == "awaiting"


def test_resume_and_compact_do_not_wipe_state(tmp_path):
    """Codex 的 source 是 startup/resume/clear/compact（没有 CC 的 fork）。"""
    p, T = tmp_path / "s.json", "t1"
    send(p, "UserPromptSubmit", turn_id=T)
    send(p, "PreToolUse", turn_id=T, tool_name="shell", tool_input={}, tool_use_id="u1")
    for source in ("resume", "compact"):
        assert send(p, "SessionStart", source=source)["state"] == "executing", source
    assert send(p, "SessionStart", source="clear")["state"] == "idle"


def test_label_says_codex_not_hermes(tmp_path):
    p = tmp_path / "s.json"
    assert send(p, "UserPromptSubmit", turn_id="t1")["detail"].startswith("Codex")


def test_garbage_input_still_exits_zero(tmp_path):
    for bad in ("", "not json", "[]", '{"hook_event_name": 123}'):
        assert invoke(tmp_path / "s.json", bad).returncode == 0
