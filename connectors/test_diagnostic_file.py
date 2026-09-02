"""出错时**要留下痕迹** —— 三层诊断里的第 2 层。

stderr 是给人看的，但没人在看：dsh 那条链路直接把子进程的 stderr 设成 `ignore`，
另外几家也只在自己的错误面板里留一行。所以 `diagnostic()` 还要落一个文件，
让 app 能把**具体原因**说出来，而不是只显示「装了但不动」。

（第 3 层 —— 插件根本没跑起来 —— 这里够不着：那时候我们的代码一行都不会执行。
那一层只能由 app 从外面判「装了却从没上报过」，见 connectors.rs。）
"""

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
HOOKS = {
    "claude-code": HERE / "claude-code/agent-avatar-hook.py",
    "codex": HERE / "codex/agent-avatar-hook.py",
    "workbuddy": HERE / "workbuddy/agent-avatar-hook.py",
    "dsh": HERE / "dsh/agent-avatar-hook.py",
    "hermes": HERE / "hermes/agent-avatar-hook.py",
}


def feed(hook, payload, tmp_path):
    environment = dict(os.environ, TMPDIR=str(tmp_path), TEMP=str(tmp_path), TMP=str(tmp_path))
    return subprocess.run([sys.executable, str(hook)], input=payload,
                          capture_output=True, env=environment, check=False)


def test_a_broken_event_leaves_a_readable_trace(tmp_path):
    result = feed(HOOKS["claude-code"], b"{ not json at all", tmp_path)
    # 🔴 观察者绝不能返回 2：那在 Claude Code / Codex 里是 block
    assert result.returncode == 0, result.stderr
    written = list(tmp_path.glob("agent-avatar-diagnostic.*.json"))
    assert written, "出了错却什么都没留下 —— app 就只能显示「装了但不动」"
    record = json.loads(written[0].read_text(encoding="utf-8"))
    assert record["harness"] == "claude-code"
    assert "json" in record["message"].lower() or "expecting" in record["message"].lower()
    # 解释器路径是最有用的一条：Windows 上「装了但不动」十有八九是它不对
    assert record["python"] == sys.executable
    assert record["connector_version"]
    assert record["at"].endswith("Z")


def test_every_harness_writes_under_its_own_name(tmp_path):
    # 同时开着两家时，两份诊断不能互相覆盖 —— 否则查的是另一家的问题
    for harness, hook in HOOKS.items():
        scratch = tmp_path / harness
        scratch.mkdir()
        feed(hook, b"{ broken", scratch)
        expected = "agent-avatar-diagnostic.%s.json" % ("hermes" if harness == "hermes" else harness)
        assert (scratch / expected).is_file(), "%s 没写出 %s" % (harness, expected)


def test_a_good_event_leaves_no_diagnostic(tmp_path):
    # 正常跑的时候不该留下噪声，否则「有没有诊断文件」这条信号就没意义了
    feed(HOOKS["claude-code"], b'{"hook_event_name":"UserPromptSubmit","session_id":"s1"}', tmp_path)
    assert (tmp_path / "agent-avatar-state.claude-code.json").is_file()
    assert not list(tmp_path.glob("agent-avatar-diagnostic.*.json"))


def test_writing_a_diagnostic_never_becomes_the_failure(tmp_path):
    """诊断本身不能炸。

    它是在 except 分支里被调用的 —— 在这里抛异常等于把「一条事件被忽略」
    升级成「hook 崩了」，而 hook 崩了在 Claude Code 里可能就是退出码 2（block）。
    """
    sys.path.insert(0, str(HERE.parent / "bridge"))
    from state_machine import diagnostic                     # noqa: E402

    # 落点不可写（指到一个不存在的深路径）时，它必须安静地放弃
    previous = os.environ.get("AGENT_AVATAR_STATE_PATH")
    os.environ["AGENT_AVATAR_STATE_PATH"] = str(tmp_path / "no" / "such" / "dir" / "state.json")
    try:
        diagnostic("write me nowhere", "claude-code")        # 不抛异常就算通过
    finally:
        if previous is None:
            os.environ.pop("AGENT_AVATAR_STATE_PATH", None)
        else:
            os.environ["AGENT_AVATAR_STATE_PATH"] = previous
