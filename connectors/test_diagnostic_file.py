"""A failure **must leave a trace** — layer 2 of the three diagnostic layers.

stderr is for humans, but nobody is reading it: the dsh path sets the subprocess's
stderr to `ignore` outright, and the others only keep a line in their own error
panels. So `diagnostic()` also drops a file, which lets the app state **the actual
reason** instead of just showing "installed but nothing moves".

(Layer 3 — the plugin never ran at all — is out of reach here: not a line of our code
executes in that case. Only the app can spot it from the outside, as "installed but
has never reported"; see connectors.rs.)
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
    # 🔴 An observer must never return 2: that is a block in Claude Code and Codex
    assert result.returncode == 0, result.stderr
    written = list(tmp_path.glob("agent-avatar-diagnostic.*.json"))
    assert written, "something failed and left no trace — the app could then only say \"installed but nothing moves\""
    record = json.loads(written[0].read_text(encoding="utf-8"))
    assert record["harness"] == "claude-code"
    assert "json" in record["message"].lower() or "expecting" in record["message"].lower()
    # The interpreter path is the most useful field: on Windows, "installed but nothing
    # moves" is nine times out of ten the wrong one
    assert record["python"] == sys.executable
    assert record["connector_version"]
    assert record["at"].endswith("Z")


def test_every_harness_writes_under_its_own_name(tmp_path):
    # With two harnesses running at once the two diagnostics must not overwrite each
    # other — otherwise you end up debugging the wrong one
    for harness, hook in HOOKS.items():
        scratch = tmp_path / harness
        scratch.mkdir()
        feed(hook, b"{ broken", scratch)
        expected = "agent-avatar-diagnostic.%s.json" % ("hermes" if harness == "hermes" else harness)
        assert (scratch / expected).is_file(), "%s did not write %s" % (harness, expected)


def test_a_good_event_leaves_no_diagnostic(tmp_path):
    # A healthy run must leave no noise behind, otherwise "is there a diagnostic file"
    # stops being a signal at all
    feed(HOOKS["claude-code"], b'{"hook_event_name":"UserPromptSubmit","session_id":"s1"}', tmp_path)
    assert (tmp_path / "agent-avatar-state.claude-code.json").is_file()
    assert not list(tmp_path.glob("agent-avatar-diagnostic.*.json"))


def test_writing_a_diagnostic_never_becomes_the_failure(tmp_path):
    """Writing a diagnostic must never become the failure.

    It is called from an except branch — raising here would promote "one event was
    ignored" into "the hook crashed", and a crashed hook in Claude Code can mean exit
    code 2, which blocks.
    """
    sys.path.insert(0, str(HERE.parent / "bridge"))
    from state_machine import diagnostic                     # noqa: E402

    # When the destination is unwritable (a deep path that does not exist) it has to give
    # up quietly
    previous = os.environ.get("AGENT_AVATAR_STATE_PATH")
    os.environ["AGENT_AVATAR_STATE_PATH"] = str(tmp_path / "no" / "such" / "dir" / "state.json")
    try:
        diagnostic("write me nowhere", "claude-code")        # passing == not raising
    finally:
        if previous is None:
            os.environ.pop("AGENT_AVATAR_STATE_PATH", None)
        else:
            os.environ["AGENT_AVATAR_STATE_PATH"] = previous
