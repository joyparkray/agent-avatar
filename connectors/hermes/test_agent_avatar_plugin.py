"""Hermes 插件入口的测试。

**按 Hermes 自己的方式加载插件**（`hermes_cli/plugins.py:2064` 的
`spec_from_file_location(..., submodule_search_locations=[plugin_dir])`
＋ 设 `__package__` / `__path__`），否则 `from .state_machine import ...`
这条相对导入根本不会被走到，测了也是假的。
"""

import importlib.util
import json
import os
import shutil
import sys
import types
from pathlib import Path

SOURCE = Path(__file__).with_name("plugin") / "agent-avatar"
CORE = Path(__file__).resolve().parents[2] / "bridge" / "state_machine.py"


def load_plugin(tmp_path, state_path):
    """复刻 install-plugin.sh 的落盘 + Hermes 的包式加载。"""
    plugin_dir = tmp_path / "agent-avatar"
    plugin_dir.mkdir()
    for name in ("plugin.yaml", "__init__.py"):
        shutil.copy(SOURCE / name, plugin_dir / name)
    shutil.copy(CORE, plugin_dir / "state_machine.py")

    parent = "agent_avatar_test_ns"
    if parent not in sys.modules:
        namespace = types.ModuleType(parent)
        namespace.__path__ = []
        namespace.__package__ = parent
        sys.modules[parent] = namespace

    module_name = parent + "." + tmp_path.name.replace("-", "_")
    spec = importlib.util.spec_from_file_location(
        module_name, plugin_dir / "__init__.py",
        submodule_search_locations=[str(plugin_dir)],
    )
    module = importlib.util.module_from_spec(spec)
    module.__package__ = module_name
    module.__path__ = [str(plugin_dir)]
    sys.modules[module_name] = module
    os.environ["AGENT_AVATAR_STATE_PATH"] = str(state_path)
    spec.loader.exec_module(module)
    return module


class Recorder:
    """最小的 ctx 替身：只需要 register_hook。"""

    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, callback):
        self.hooks.setdefault(name, []).append(callback)


def registered(tmp_path, state_path):
    module = load_plugin(tmp_path, state_path)
    ctx = Recorder()
    module.register(ctx)
    return module, ctx


def fire(ctx, event, **kwargs):
    for callback in ctx.hooks[event]:
        assert callback(**kwargs) is None, "观察者插件必须返回 None（不下指令）"


def test_registers_exactly_the_declared_hooks(tmp_path):
    """plugin.yaml 声明的事件与代码注册的必须一致 —— 两处漂了就是「某类信号永远不到」。"""
    module, ctx = registered(tmp_path, tmp_path / "state.json")
    declared = [
        line.strip()[2:]
        for line in (SOURCE / "plugin.yaml").read_text().splitlines()
        if line.startswith("  - ")
    ]
    assert set(declared) == set(module.HOOKS) == set(ctx.hooks)


def test_never_registers_decision_hooks(tmp_path):
    """pre_verify 之类的返回值会被解释成指令。观察者绝不能注册它们。"""
    module, _ = registered(tmp_path, tmp_path / "state.json")
    assert not {"pre_verify", "pre_gateway_dispatch", "transform_llm_output",
                "transform_tool_result", "transform_terminal_output"} & set(module.HOOKS)


def test_payload_matches_the_shell_hook_wire_shape(tmp_path):
    """与 agent/shell_hooks.py:_serialize_payload 同口径：两条入口喂给状态机的形状必须一致。"""
    module, _ = registered(tmp_path, tmp_path / "state.json")
    payload = module._payload("pre_tool_call", {
        "tool_name": "terminal", "args": {"command": "ls"},
        "session_id": "s1", "task_id": "t1", "tool_call_id": "c1",
    })
    assert payload["hook_event_name"] == "pre_tool_call"
    assert payload["tool_name"] == "terminal"
    assert payload["tool_input"] == {"command": "ls"}
    assert payload["session_id"] == "s1"
    # 非顶层键原样进 extra
    assert payload["extra"] == {"task_id": "t1", "tool_call_id": "c1"}

    # subagent_stop 只带 parent_session_id —— 必须回落，否则子代理记账挂在 "default" 上
    stop = module._payload("subagent_stop", {"parent_session_id": "p1", "child_session_id": "c9"})
    assert stop["session_id"] == "p1"
    assert stop["extra"]["child_session_id"] == "c9"

    # args 不是 dict 时 tool_input 必须是 None，不能把字符串塞进去
    assert module._payload("pre_tool_call", {"args": "not-a-dict"})["tool_input"] is None


def test_drives_the_state_file_end_to_end(tmp_path):
    state = tmp_path / "state.json"
    _, ctx = registered(tmp_path, state)

    fire(ctx, "pre_llm_call", session_id="s1", turn_id="t1")
    assert json.loads(state.read_text())["state"] == "writing"

    fire(ctx, "pre_tool_call", session_id="s1", tool_name="terminal",
         args={"command": "ls"}, tool_call_id="c1", turn_id="t1")
    assert json.loads(state.read_text())["state"] == "executing"

    fire(ctx, "post_tool_call", session_id="s1", tool_name="terminal",
         tool_call_id="c1", turn_id="t1", status="ok")
    fire(ctx, "on_session_end", session_id="s1", turn_id="t1", completed=True, failed=False)
    snapshot = json.loads(state.read_text())
    assert snapshot["state"] == "idle"
    assert snapshot["detail"] == "Hermes is ready"


def test_a_bad_event_never_raises_into_hermes(tmp_path):
    """Hermes 的 invoke_hook 会吞异常，但它**没有超时**；我们自己也不往 agent.log 刷 warning。"""
    _, ctx = registered(tmp_path, tmp_path / "state.json")
    fire(ctx, "pre_tool_call", session_id="s1", args={"command": object()})
