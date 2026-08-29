"""dsh 入口的单测。翻译在 JS 侧，这里只测「白名单 + 永不抛」两件事。"""

import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent-avatar-hook.py")


def run(payload, tmpdir):
    """跑一次入口，返回 (退出码, 状态文件内容或 None)。"""
    env = dict(os.environ, TMPDIR=tmpdir)
    env.pop("AGENT_AVATAR_STATE_PATH", None)
    result = subprocess.run([sys.executable, HOOK], input=json.dumps(payload) if isinstance(payload, (dict, list)) else payload,
                            capture_output=True, text=True, env=env)
    path = os.path.join(tmpdir, "agent-avatar-state.dsh.json")
    state = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else None
    return result, state


def test_writes_its_own_harness_file_not_the_shared_one():
    with tempfile.TemporaryDirectory() as tmp:
        result, state = run({"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "1"}, tmp)
        assert result.returncode == 0
        assert state["state"] == "writing"
        assert state["detail"].startswith("DeepSeek Harness")
        # 每家写自己的文件；写到 Hermes 那份上就会互相抢
        assert not os.path.exists(os.path.join(tmp, "agent-avatar-state.json"))


def test_tool_call_pairs_into_executing_then_back():
    with tempfile.TemporaryDirectory() as tmp:
        run({"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "1"}, tmp)
        _, busy = run({"hook_event_name": "pre_tool_call", "session_id": "s1", "turn_id": "1",
                       "tool_use_id": "c1", "tool_name": "bash"}, tmp)
        assert busy["state"] == "executing"
        _, done = run({"hook_event_name": "post_tool_call", "session_id": "s1", "turn_id": "1",
                       "tool_use_id": "c1", "status": "ok"}, tmp)
        assert done["state"] == "writing"
        _, end = run({"hook_event_name": "post_llm_call", "session_id": "s1", "turn_id": "1"}, tmp)
        assert end["state"] == "idle"


def test_failed_tool_shows_error():
    with tempfile.TemporaryDirectory() as tmp:
        run({"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "1"}, tmp)
        run({"hook_event_name": "pre_tool_call", "session_id": "s1", "turn_id": "1", "tool_use_id": "c1"}, tmp)
        _, state = run({"hook_event_name": "post_tool_call", "session_id": "s1", "turn_id": "1",
                        "tool_use_id": "c1", "status": "error"}, tmp)
        assert state["state"] == "error"


def test_unknown_and_broken_input_never_fail():
    """🔴 永远 exit 0（§7.1），且不认识的事件不落盘。"""
    with tempfile.TemporaryDirectory() as tmp:
        for payload in ({"hook_event_name": "tools/execute"}, {"hook_event_name": None}, [1, 2], "not json", ""):
            result, _ = run(payload, tmp)
            assert result.returncode == 0, payload
        assert not os.path.exists(os.path.join(tmp, "agent-avatar-state.dsh.json"))
