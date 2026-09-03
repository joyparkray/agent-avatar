"""Tests for `localize.py` — the one extra step a Windows connector install needs.

What it changes is **the shape of a command line**, and a wrong shape fails
silently: the hook never starts, the exit code is not 2, nothing reports an error,
and the avatar simply never moves. So these tests pin the shape itself rather than
settling for "the command finished without complaining".
"""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
BRIDGE = HERE.parent / "bridge"
LOCALIZE = HERE / "localize.py"


def build(root, harness):
    """Lay out one harness's plugin directory the way the published tree does
    (which is what assemble.sh produces)."""
    plugin = root / "plugins" / harness / "agent-avatar"
    if harness == "codex":
        (plugin / "scripts").mkdir(parents=True)
        shutil.copy(HERE / "codex/plugin/agent-avatar/hooks.json", plugin / "hooks.json")
        for name in ("state_machine.py", "pascal_events.py"):
            shutil.copy(BRIDGE / name, plugin / "scripts" / name)
        shutil.copy(HERE / "codex/agent-avatar-hook.py", plugin / "scripts")
    elif harness == "dsh":
        plugin.mkdir(parents=True)
        shutil.copy(HERE / "dsh/plugin/agent-avatar/index.mjs", plugin)
        shutil.copy(HERE / "dsh/agent-avatar-hook.py", plugin)
        shutil.copy(BRIDGE / "state_machine.py", plugin)
    else:                                     # claude-code / workbuddy share a layout
        (plugin / "hooks").mkdir(parents=True)
        shutil.copy(HERE / harness / "plugin/agent-avatar/hooks/hooks.json", plugin / "hooks")
        for name in ("state_machine.py", "pascal_events.py"):
            shutil.copy(BRIDGE / name, plugin / "hooks" / name)
        shutil.copy(HERE / harness / "agent-avatar-hook.py", plugin / "hooks")
    return plugin


def localize(root, harness, check=True):
    return subprocess.run([sys.executable, str(LOCALIZE), harness, "--root",
                           str(root / "plugins" / harness / "agent-avatar")],
                          capture_output=True, text=True, encoding="utf-8", check=check)


def commands(plugin, relative="hooks/hooks.json"):
    document = json.loads((plugin / relative).read_text(encoding="utf-8"))
    return [hook for matchers in document["hooks"].values()
            for matcher in matchers for hook in matcher["hooks"]]


def test_rewrites_every_command_into_the_shape_both_shells_accept(tmp_path):
    plugin = build(tmp_path, "claude-code")
    localize(tmp_path, "claude-code")
    for hook in commands(plugin):
        command = hook["command"]
        # Interpreter: absolute, forward slashes, **unquoted** (PowerShell only
        # errors when the *first* token is quoted)
        interpreter = command.split(" ", 1)[0]
        assert "\\" not in interpreter, command
        assert Path(interpreter).exists() or interpreter.endswith(".exe"), command
        assert not interpreter.startswith('"'), command
        # The script path **is** quoted: the placeholder can expand to a path with
        # spaces (a username with a space is common on Windows)
        assert ' "${CLAUDE_PLUGIN_ROOT}/hooks/agent-avatar-hook.py"' in command, command
        # `; exit 0` is not optional: a broken script path exits with exactly 2, and 2 blocks
        assert command.rstrip().endswith("; exit 0"), command


def test_codex_keeps_the_posix_line_and_adds_a_windows_one(tmp_path):
    # Codex has commandWindows, a Windows-only override — one hooks.json serves both
    # platforms. Rewriting the POSIX line as well would hand mac users a plugin that
    # points at a Windows path.
    plugin = build(tmp_path, "codex")
    localize(tmp_path, "codex")
    for hook in commands(plugin, "hooks.json"):
        assert hook["command"].startswith("/usr/bin/python3 "), hook
        assert "${PLUGIN_ROOT}" in hook["commandWindows"]
        assert hook["commandWindows"].rstrip().endswith("; exit 0")


def test_dsh_keeps_the_env_override_in_front(tmp_path):
    # Swapping interpreters must not require a reinstall: the environment variable
    # wins over the default baked in at install time
    plugin = build(tmp_path, "dsh")
    localize(tmp_path, "dsh")
    text = (plugin / "index.mjs").read_text(encoding="utf-8")
    assert 'process.env.AGENT_AVATAR_PYTHON || "' in text
    assert '|| "python3"' not in text, "the default should have been replaced with this machine's interpreter"


def test_running_it_twice_changes_nothing(tmp_path):
    # Reinstalling is routine. If a second pass kept growing the command line, the
    # breakage would be silent.
    plugin = build(tmp_path, "claude-code")
    localize(tmp_path, "claude-code")
    once = (plugin / "hooks/hooks.json").read_text(encoding="utf-8")
    localize(tmp_path, "claude-code")
    assert (plugin / "hooks/hooks.json").read_text(encoding="utf-8") == once


def test_hermes_is_a_no_op(tmp_path):
    # The only harness that needs no localisation: an in-process Python package that
    # runs in Hermes's own interpreter and spawns nothing
    (tmp_path / "plugins/hermes/agent-avatar").mkdir(parents=True)
    result = localize(tmp_path, "hermes")
    assert "hermes" in result.stdout


def test_a_broken_tree_fails_loudly_instead_of_installing_something_dead(tmp_path):
    # With the core missing the hook cannot start, and in a real registration that
    # failure makes **no sound at all** (the hook always exits 0). The smoke test is
    # the only place that can make it audible.
    plugin = build(tmp_path, "claude-code")
    os.remove(plugin / "hooks/state_machine.py")
    result = localize(tmp_path, "claude-code", check=False)
    assert result.returncode != 0
    assert "smoke test failed" in result.stdout + result.stderr
