import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest


SCRIPT = Path(__file__).with_name("agent-avatar-hook.py")


def hook_env(path, **overrides):
    """继承环境但**剔除真 token**：在 Hermes desktop 拉起的会话里跑 pytest 时，
    hook 会把继承到的 HERMES_DASHBOARD_SESSION_TOKEN 写进快照，让断言快照键集合的
    用例假失败。token 的行为由 test_carries_the_session_token 显式注入来覆盖。"""
    env = {key: value for key, value in os.environ.items() if key != "HERMES_DASHBOARD_SESSION_TOKEN"}
    env["AGENT_AVATAR_STATE_PATH"] = str(path)
    env.update(overrides)
    return env


def invoke(path, payload):
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=payload if isinstance(payload, str) else json.dumps(payload),
        text=True,
        capture_output=True,
        env=hook_env(path),
        check=False,
    )


def test_real_bridge_transitions_and_atomic_snapshot(tmp_path):
    path = tmp_path / "state.json"
    events = [
        ({"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "t1"}, "writing"),
        ({"hook_event_name": "pre_tool_call", "session_id": "s1", "tool_name": "exec_command", "tool_call_id": "c1"}, "executing"),
        ({"hook_event_name": "post_tool_call", "session_id": "s1", "tool_name": "exec_command", "tool_call_id": "c1", "status": "error"}, "error"),
        ({"hook_event_name": "on_session_reset", "session_id": "s1"}, "idle"),
    ]

    for sequence, (payload, expected) in enumerate(events, 1):
        result = invoke(path, payload)
        assert result.returncode == 0, result.stderr
        snapshot = json.loads(path.read_text(encoding="utf-8"))
        assert set(snapshot) == {"state", "detail", "sequence", "updated_at"}
        assert snapshot["state"] == expected
        assert snapshot["sequence"] == sequence
        assert snapshot["updated_at"].endswith("Z")
        assert not list(tmp_path.glob(".agent-avatar-state-*"))


def test_only_current_session_drives_state(tmp_path):
    """只聚合 last_active 会话；其他会话（含残留 subagent）不污染当前状态。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_tool_call", "session_id": "working", "tool_name": "exec_command", "tool_call_id": "c1"})
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "thinking", "turn_id": "t1"})
    # last_active=thinking → writing；working 的 executing 不再跨会话覆盖
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "writing"


def test_stale_subagent_session_does_not_poison_syncing(tmp_path):
    """回归：其他会话残留 subagent 不得把当前会话顶成 syncing（曾导致「思考时显示 syncing」）。"""
    path = tmp_path / "state.json"
    # 一个 no-session-id 的残留会话先起了个子代理（无收尾）
    invoke(path, {"hook_event_name": "subagent_start", "session_id": "ghost"})
    # 当前会话开始思考（LLM 生成）
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "thinking", "turn_id": "t1"})
    # 只聚合当前(thinking)会话 → writing；ghost 的 subagents=1 不顶成 syncing
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "writing"


def test_invalid_input_is_fail_open(tmp_path):
    path = tmp_path / "state.json"
    result = invoke(path, "not json")
    assert result.returncode == 0
    assert "agent-avatar-hook:" in result.stderr
    assert not path.exists()


def test_carries_the_session_token_and_keeps_it_when_absent(tmp_path):
    """token 由 hook 从继承来的环境变量带出；读不到时必须保留上一次的值。"""
    path = tmp_path / "state.json"
    start = {"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "t1"}

    env = hook_env(path, HERMES_DASHBOARD_SESSION_TOKEN="tok-abc")
    result = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(start), text=True, capture_output=True, env=env, check=False)
    assert result.returncode == 0, result.stderr
    assert json.loads(path.read_text(encoding="utf-8"))["audio"] == {"token": "tok-abc"}

    # 权限那条保证单独一个用例，见 test_locks_the_state_file_to_the_owner

    # gateway / cron 会话不是 desktop 的后代，环境里没有 token —— 不能把已有的抹掉
    bare = hook_env(path)
    follow = {"hook_event_name": "pre_tool_call", "session_id": "s1", "tool_name": "exec_command", "tool_call_id": "c1"}
    result = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(follow), text=True, capture_output=True, env=bare, check=False)
    assert result.returncode == 0, result.stderr
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    assert snapshot["state"] == "executing"
    assert snapshot["audio"] == {"token": "tok-abc"}


@pytest.mark.skipif(
    os.name == "nt",
    reason="Windows 无 POSIX 权限位，状态文件权限口径待拍板，见 WINDOWS-PORT.md WP3",
)
def test_locks_the_state_file_to_the_owner(tmp_path):
    """状态文件里有凭据与工具调用文本，权限必须锁到属主可读。

    单独成一个用例是为了 Windows：那里 `tempfile.mkstemp` 的 0600 是 POSIX 语义，
    NTFS 走 ACL 继承，实测拿到 666。塞在别的用例里就得整条 skip，会连带丢掉
    token 保留那部分覆盖。拆出来之后，Windows 上只有这一条显示为 skipped。
    """
    path = tmp_path / "state.json"
    start = {"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "t1"}
    env = hook_env(path, HERMES_DASHBOARD_SESSION_TOKEN="tok-abc")
    result = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(start), text=True, capture_output=True, env=env, check=False)
    assert result.returncode == 0, result.stderr
    assert oct(path.stat().st_mode)[-3:] == "600"


def test_turn_end_clears_stale_active(tmp_path):
    """回归（根治永久卡执行态）：某 turn 里 pre_tool_call 存了 active，但 post_tool_call 因
    call_id 对不上从未 pop（长会话/漏配对）。turn 结束（post_llm_call）必须结清该 turn 的
    in-flight 工具，否则皮肤会永久卡 executing/writing、不回 idle。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "pre_tool_call", "session_id": "s1", "turn_id": "t1",
                  "tool_name": "exec_command", "tool_call_id": "unmatched-call"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "executing"
    # 不触发配对的 post_tool_call（模拟漏掉/对不上），直接结束 turn —— 应清回 idle
    invoke(path, {"hook_event_name": "post_llm_call", "session_id": "s1", "turn_id": "t1"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "idle"


def test_stale_active_on_dead_turn_never_escalates_to_executing(tmp_path):
    """防御：active 里工具所属 turn 已不在 turns（乱序/跨轮残留）→ 该条目不计入忙态。
    即便 phase 暂留 writing，也绝不能被这个 stale active 顶成 executing（永久卡执行态的根源）。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_tool_call", "session_id": "s1", "turn_id": "ghost-turn",
                  "tool_name": "exec_command", "tool_call_id": "c1"})
    state = json.loads(path.read_text(encoding="utf-8"))["state"]
    assert state != "executing", state


def test_post_tool_call_keeps_writing_while_turn_is_still_active(tmp_path):
    """回归（多工具思考 turn 会误回 idle）：工具结束（post_tool_call）后若该 turn 仍在
    llm_active（LLM 还在生成/思考），状态必须保持 writing，不能回 idle ——
    否则 desktop 还在思考、皮肤却瞬间掉到 idle。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "pre_tool_call", "session_id": "s1", "turn_id": "t1",
                  "tool_name": "exec_command", "tool_call_id": "c1"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "executing"
    # 工具结束，但 turn 未走 post_llm_call（LLM 继续思考）→ 保持 writing
    invoke(path, {"hook_event_name": "post_tool_call", "session_id": "s1",
                  "tool_name": "exec_command", "tool_call_id": "c1"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "writing"


def test_blocked_tool_emits_blocked_reaction_not_error(tmp_path):
    """blocked 反应：Hermes 用 status=blocked 表示工具被拒，应发 blocked reaction 而不是判成 error。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "pre_tool_call", "session_id": "s1", "turn_id": "t1",
                  "tool_name": "exec_command", "tool_call_id": "c1"})
    invoke(path, {"hook_event_name": "post_tool_call", "session_id": "s1",
                  "tool_name": "exec_command", "tool_call_id": "c1", "status": "blocked"})
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    assert snapshot["reaction"]["kind"] == "blocked"
    assert snapshot["reaction"]["sequence"] == 1
    assert snapshot["state"] != "error"  # blocked 不当 error，turn 继续


def test_interrupted_emits_interrupted_reaction(tmp_path):
    """interrupted 反应：用户在 turn 结束前打断（extra.interrupted=True）→ 一条 reaction。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "on_session_end", "session_id": "s1", "turn_id": "t1", "interrupted": True})
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    assert snapshot["reaction"]["kind"] == "interrupted"
    assert snapshot["reaction"]["sequence"] == 1


def test_untracked_subagent_stop_does_not_leak_awaiting(tmp_path):
    """回归（永久卡忙态的根源）：subagent_stop 的 child_id 与记账对不上时，
    只打日志不出队会让 display_state 永远多算一个 awaiting —— 跨 turn、跨 session_end
    都清不掉，Rust 的 300s 兜底也救不了（每个事件都会刷新文件 mtime）。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "subagent_start", "session_id": "s1", "child_session_id": "A"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "awaiting"
    result = invoke(path, {"hook_event_name": "subagent_stop", "session_id": "s1", "child_session_id": "B"})
    assert "untracked subagent" in result.stderr  # 记账对不上要留痕
    assert json.loads(path.read_text(encoding="utf-8"))["state"] != "awaiting"


def test_session_end_clears_subagents(tmp_path):
    """兜底：subagent_stop 根本没来（会话被杀/漏发）时，会话结束必须清掉子代理记账。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "subagent_start", "session_id": "s1", "child_session_id": "A"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "awaiting"
    invoke(path, {"hook_event_name": "on_session_end", "session_id": "s1", "turn_id": "t1"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "idle"


def test_reaction_carries_a_monotonic_timestamp(tmp_path):
    """回归：反应的去重键必须是 `at` 而不是 `sequence`。sequence 存在易失的 .sessions 里，
    文件重建后从 1 重新开始，皮肤会把下一条反应当成「已见过」丢掉（整整漏一次反应）。"""
    path = tmp_path / "state.json"
    interrupted = {"hook_event_name": "on_session_end", "session_id": "s1", "turn_id": "t1", "interrupted": True}
    invoke(path, interrupted)
    first = json.loads(path.read_text(encoding="utf-8"))["reaction"]

    (tmp_path / "state.json.sessions").unlink()  # 模拟 TMPDIR 清理 / schema 变更后的重建
    time.sleep(0.01)
    invoke(path, interrupted)
    second = json.loads(path.read_text(encoding="utf-8"))["reaction"]

    assert first["sequence"] == second["sequence"] == 1  # 计数确实复位了
    assert second["at"] > first["at"]                    # 但 at 单调，皮肤据此仍能触发


def test_subagent_own_session_never_drives_the_avatar(tmp_path):
    """子代理跑自己的 conversation loop，事件带的是**它自己的** session_id。这些事件不得
    夺走 last_active —— 否则子代理的一个工具报错会把 Echo 顶成 error，而父会话其实好好的。
    父会话「派了子代理」仍是 syncing：那是父会话真实的状态。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "P", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "subagent_start", "parent_session_id": "P", "child_session_id": "C"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "awaiting"

    for child_event in (
            {"hook_event_name": "pre_llm_call", "session_id": "C", "turn_id": "ct1"},
            {"hook_event_name": "pre_tool_call", "session_id": "C", "turn_id": "ct1",
             "tool_name": "exec_command", "tool_call_id": "cc1"},
            {"hook_event_name": "post_tool_call", "session_id": "C", "turn_id": "ct1",
             "tool_name": "exec_command", "tool_call_id": "cc1", "status": "error"}):
        invoke(path, child_event)
        assert json.loads(path.read_text(encoding="utf-8"))["state"] == "awaiting", child_event["hook_event_name"]

    invoke(path, {"hook_event_name": "subagent_stop", "parent_session_id": "P", "child_session_id": "C", "child_status": "success"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "writing"  # 回到父会话自己的状态


def test_nested_subagent_sessions_are_ignored_too(tmp_path):
    """嵌套委派：子代理再派子代理时，那条 subagent_start 归属已被忽略的会话，
    但孙代理仍要登记，否则它的事件会漏进来接着夺 last_active。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "P", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "subagent_start", "parent_session_id": "P", "child_session_id": "C"})
    invoke(path, {"hook_event_name": "subagent_start", "session_id": "C", "child_session_id": "D"})
    invoke(path, {"hook_event_name": "post_tool_call", "session_id": "D",
                  "tool_name": "exec_command", "tool_call_id": "d1", "status": "error"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "awaiting"


def test_parent_session_errors_still_show(tmp_path):
    """反向保证：忽略的只是子代理会话，父会话自己的工具报错必须照常显示。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "P", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "post_tool_call", "session_id": "P", "turn_id": "t1",
                  "tool_name": "exec_command", "tool_call_id": "p1", "status": "error"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "error"


BACKGROUND_REVIEW_MESSAGE = (
    "You can only call memory and skill management tools. "
    "Other tools will be denied at runtime — do not attempt them."
)


def test_syncing_splits_into_awaiting_reviewing_and_syncing(tmp_path):
    """原来这四件事都叫 syncing，标签上分不出来：
    派子代理 / 调 codex CLI（都是在等另一个 agent）、后台更新记忆技能、同步外部服务。"""
    def state_after(events):
        path = tmp_path / ("state-%d.json" % len(list(tmp_path.iterdir())))
        for event in events:
            invoke(path, event)
        return json.loads(path.read_text(encoding="utf-8"))["state"]

    turn = {"hook_event_name": "pre_llm_call", "session_id": "P", "turn_id": "t1"}
    assert state_after([turn, {"hook_event_name": "subagent_start", "parent_session_id": "P",
                               "child_session_id": "C"}]) == "awaiting"
    assert state_after([turn, {"hook_event_name": "pre_tool_call", "session_id": "P", "turn_id": "t1",
                               "tool_name": "exec_command", "tool_call_id": "x",
                               "tool_input": {"command": "codex exec 'review this'"}}]) == "awaiting"
    assert state_after([{"hook_event_name": "pre_llm_call", "session_id": "P", "turn_id": "r1",
                         "user_message": BACKGROUND_REVIEW_MESSAGE}]) == "reviewing"
    assert state_after([turn, {"hook_event_name": "pre_tool_call", "session_id": "P", "turn_id": "t1",
                               "tool_name": "github_create_issue", "tool_call_id": "g"}]) == "syncing"
    # 未被牵连的两类
    assert state_after([turn, {"hook_event_name": "pre_tool_call", "session_id": "P", "turn_id": "t1",
                               "tool_name": "web_search", "tool_call_id": "w"}]) == "researching"
    assert state_after([turn, {"hook_event_name": "pre_tool_call", "session_id": "P", "turn_id": "t1",
                               "tool_name": "exec_command", "tool_call_id": "e"}]) == "executing"


def test_reviewing_yields_to_a_new_turn(tmp_path):
    """reviewing 优先级低于 writing：后台整理记忆时用户又说话了，该显示当前对话。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "P", "turn_id": "r1",
                  "user_message": BACKGROUND_REVIEW_MESSAGE})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "reviewing"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "P", "turn_id": "t2"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "writing"


def test_awaiting_outranks_a_tool_running_in_the_same_turn(tmp_path):
    """awaiting 优先级最高（除 error）：整个 turn 卡在等别人身上，比自己在跑的工具更有代表性。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "P", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "pre_tool_call", "session_id": "P", "turn_id": "t1",
                  "tool_name": "exec_command", "tool_call_id": "e"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "executing"
    invoke(path, {"hook_event_name": "subagent_start", "parent_session_id": "P", "child_session_id": "C"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "awaiting"


def test_a_turn_that_failed_shows_error_even_when_every_tool_succeeded(tmp_path):
    """on_session_end 的 `failed` 是这一轮的权威结论，比从工具 status 反推准。

    Hermes 的 on_session_end 是 **turn 级**事件（payload 带 turn_id/completed/failed/
    turn_exit_reason）。工具全成功、turn 仍可能失败 —— 那时只看工具 status 会显示 idle。
    """
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "P", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "pre_tool_call", "session_id": "P", "turn_id": "t1",
                  "tool_name": "exec_command", "tool_call_id": "c1"})
    invoke(path, {"hook_event_name": "post_tool_call", "session_id": "P", "turn_id": "t1",
                  "tool_name": "exec_command", "tool_call_id": "c1", "status": "ok"})
    invoke(path, {"hook_event_name": "on_session_end", "session_id": "P", "turn_id": "t1",
                  "extra": {"completed": False, "failed": True}})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "error"


def test_a_successful_turn_still_ends_idle(tmp_path):
    """failed=False 不能被当成「有 failed 字段就是错」。"""
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "P", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "on_session_end", "session_id": "P", "turn_id": "t1",
                  "extra": {"completed": True, "failed": False}})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "idle"


def test_a_tool_event_without_a_session_id_joins_the_active_session(tmp_path):
    """没有 session_id 的工具事件要归给上一个活跃会话，不能自己开一个 "default" 桶。

    Hermes 在 `agent.session_id` 为空的路径（WebUI）下工具事件的 session_id 是空串。
    落进独立的桶会让工具与它自己的 pre_llm_call 记到两个会话里，turn 记账随即对不上：
    post_tool_call 找不到 llm_active，基态直接掉回 idle。
    """
    path = tmp_path / "state.json"
    invoke(path, {"hook_event_name": "pre_llm_call", "session_id": "P", "turn_id": "t1"})
    invoke(path, {"hook_event_name": "pre_tool_call", "session_id": "", "turn_id": "t1",
                  "tool_name": "exec_command", "tool_call_id": "c1"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "executing"
    # 收尾后仍要回到「LLM 还在这一轮里」而不是 idle —— 证明它记在同一个会话上
    invoke(path, {"hook_event_name": "post_tool_call", "session_id": "", "turn_id": "t1",
                  "tool_name": "exec_command", "tool_call_id": "c1", "status": "ok"})
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "writing"
