"""`localize.py` 的测试 —— Windows 上装 connector 时唯一那一步额外动作。

它改的是**命令行的形状**，而形状错了的后果是静默的：hook 起不来、退出码不是 2、
没有任何一处报错，形象就永远不动。所以这里逐条钉住形状本身，而不只是「跑完没报错」。
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
    """按发布树的布局摆出一家的插件目录（assemble.sh 做的就是这件事）。"""
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
    else:                                     # claude-code / workbuddy 同形
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
        # 解释器：绝对路径、正斜杠、**不加引号**（PowerShell 只在首个 token 带引号时报错）
        interpreter = command.split(" ", 1)[0]
        assert "\\" not in interpreter, command
        assert Path(interpreter).exists() or interpreter.endswith(".exe"), command
        assert not interpreter.startswith('"'), command
        # 脚本路径**要加引号**：占位符展开后可能带空格（Windows 上用户名带空格很常见）
        assert ' "${CLAUDE_PLUGIN_ROOT}/hooks/agent-avatar-hook.py"' in command, command
        # `; exit 0` 不能省：脚本路径失效时退出码恰好是 2，而 2 是 block
        assert command.rstrip().endswith("; exit 0"), command


def test_codex_keeps_the_posix_line_and_adds_a_windows_one(tmp_path):
    # Codex 有 commandWindows 这个 Windows 专用覆盖字段 —— 同一份 hooks.json 两个平台通用。
    # 把 POSIX 那条也改掉的话，mac 用户装到的就是一个指向 Windows 路径的插件。
    plugin = build(tmp_path, "codex")
    localize(tmp_path, "codex")
    for hook in commands(plugin, "hooks.json"):
        assert hook["command"].startswith("/usr/bin/python3 "), hook
        assert "${PLUGIN_ROOT}" in hook["commandWindows"]
        assert hook["commandWindows"].rstrip().endswith("; exit 0")


def test_dsh_keeps_the_env_override_in_front(tmp_path):
    # 换解释器不用重装：环境变量优先于装机时写死的那个默认值
    plugin = build(tmp_path, "dsh")
    localize(tmp_path, "dsh")
    text = (plugin / "index.mjs").read_text(encoding="utf-8")
    assert 'process.env.AGENT_AVATAR_PYTHON || "' in text
    assert '|| "python3"' not in text, "默认值应当已被换成本机解释器"


def test_running_it_twice_changes_nothing(tmp_path):
    # 重装是常见操作。第二遍把命令行越拼越长的话，坏法是静默的。
    plugin = build(tmp_path, "claude-code")
    localize(tmp_path, "claude-code")
    once = (plugin / "hooks/hooks.json").read_text(encoding="utf-8")
    localize(tmp_path, "claude-code")
    assert (plugin / "hooks/hooks.json").read_text(encoding="utf-8") == once


def test_hermes_is_a_no_op(tmp_path):
    # 唯一不需要本地化的一家：in-process 的 Python 包，跑在 Hermes 自己的解释器里、不 spawn
    (tmp_path / "plugins/hermes/agent-avatar").mkdir(parents=True)
    result = localize(tmp_path, "hermes")
    assert "hermes" in result.stdout


def test_a_broken_tree_fails_loudly_instead_of_installing_something_dead(tmp_path):
    # 漏拷 core 时 hook 起不来，而那种失败在真实注册里**完全没有声音**
    # （hook 永远 exit 0）。自检是唯一能把它变响的地方。
    plugin = build(tmp_path, "claude-code")
    os.remove(plugin / "hooks/state_machine.py")
    result = localize(tmp_path, "claude-code", check=False)
    assert result.returncode != 0
    assert "自检" in result.stdout + result.stderr
