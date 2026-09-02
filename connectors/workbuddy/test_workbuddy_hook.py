"""WorkBuddy 适配层测试。

主用例重放的是**实机抓取的真实事件序列**（WorkBuddy 自带的 CodeBuddy Code CLI
v2.115.0，隔离 `--settings` 取样器 + `sleep 4`；见 README §3）。
两个反直觉的地方都由用例钉住：SessionStart **迟到**、以及**没有回合字段**。
"""

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).with_name("agent-avatar-hook.py")
SESSION = "1ca9d2d2-5030-4996-98e8-8b8af19949ba"   # 实机抓到的那条会话 id


def send(path, event, **fields):
    fields.setdefault("session_id", SESSION)
    env = dict(os.environ, AGENT_AVATAR_STATE_PATH=str(path))
    result = subprocess.run([sys.executable, str(SCRIPT)],
                            input=json.dumps(dict(hook_event_name=event, **fields)),
                            text=True, capture_output=True, env=env, check=False)
    # 🔴 观察者绝不能返回 2 —— 同一份 CLI，退出码 2 会拦死工具
    assert result.returncode == 0, result.stderr
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def test_real_captured_session_drives_the_right_states(tmp_path):
    """实机序列：UserPromptSubmit → **SessionStart（迟到）** → Bash → 收尾。"""
    p = tmp_path / "state.json"

    assert send(p, "UserPromptSubmit")["state"] == "writing"
    # ⚠️ WorkBuddy 的 SessionStart 在回合开始**之后**才发。它若被当成重置，
    # 刚开的回合会被清掉，随后的工具就被 display_state 当作「所属 turn 已收尾」而跳过 ——
    # 整轮没有 executing。实机就是这么撞出来的。
    assert send(p, "SessionStart", source="startup")["state"] == "writing"
    assert send(p, "PreToolUse", tool_name="Bash", tool_input={"command": "sleep 4"},
                tool_use_id="call_1")["state"] == "executing"
    # 工具收尾后不能掉回 idle —— 回合还活着（靠 session 回落记账）
    assert send(p, "PostToolUse", tool_name="Bash", tool_use_id="call_1")["state"] == "writing"
    assert send(p, "Stop")["state"] == "idle"


def test_no_turn_field_falls_back_to_session(tmp_path):
    """WorkBuddy 既没有 prompt_id 也没有 turn_id（实机 + 其 CLI 里两个字符串都是 0 次）。

    回落到 session_id 之后，工具之间才有 writing；否则整轮只有 executing 尖峰、
    其余时间闪回 idle。
    """
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bridge"))
    from pascal_events import WORKBUDDY, translate                      # noqa: E402
    out = translate({"hook_event_name": "UserPromptSubmit", "session_id": "s1"}, WORKBUDDY)
    assert out["turn_id"] == "s1"
    assert WORKBUDDY["turn_fields"] == ()


def test_clear_still_resets(tmp_path):
    """去掉 startup 不能把 clear 也去掉 —— 那是真正的「开新局」。"""
    p = tmp_path / "state.json"
    send(p, "UserPromptSubmit")
    send(p, "PreToolUse", tool_name="Bash", tool_use_id="call_1")
    assert send(p, "SessionStart", source="clear")["state"] == "idle"


def test_permission_denied_is_a_blocked_reaction(tmp_path):
    """实机确认 WorkBuddy 会发 PermissionDenied（原判「没有」是错的）。"""
    p = tmp_path / "state.json"
    send(p, "UserPromptSubmit")
    send(p, "PreToolUse", tool_name="Bash", tool_use_id="call_1")
    snapshot = send(p, "PermissionDenied", tool_name="Bash", tool_use_id="call_1")
    assert snapshot["reaction"]["kind"] == "blocked"
    # 基态不被反应改写：工具结束了，回合还在
    assert snapshot["state"] == "writing"


def test_subagent_events_exist_and_are_accounted(tmp_path):
    """原判「WorkBuddy 没有子代理事件」也是错的 —— CLI 里 SubagentStart/Stop 都在。"""
    p = tmp_path / "state.json"
    send(p, "UserPromptSubmit")
    assert send(p, "SubagentStart", agent_id="A1")["state"] == "awaiting"
    assert send(p, "SubagentStop", agent_id="A1")["state"] == "writing"


def test_never_exits_two_on_garbage(tmp_path):
    p = tmp_path / "state.json"
    for payload in ("not json", "[]", '{"hook_event_name":"WorktreeCreate"}'):
        env = dict(os.environ, AGENT_AVATAR_STATE_PATH=str(p))
        result = subprocess.run([sys.executable, str(SCRIPT)], input=payload, text=True,
                                capture_output=True, env=env, check=False)
        assert result.returncode == 0, payload
        assert result.stdout == "", "stdout 必须为空（§7.4）"
