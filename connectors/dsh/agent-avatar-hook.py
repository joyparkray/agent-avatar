#!/usr/bin/env python3
"""DeepSeek Harness 适配层的 python 入口 —— 内部词表 payload → 状态机。

dsh 的事件翻译在同级的 `plugin/agent-avatar/index.mjs` 里（它是 in-process 的 cordis
插件，能直接读到 dsh 的对象）。本文件只做一件事：把已经是**内部词表**形状的 payload
交给共用状态机。所以这里没有 `pascal_events` —— dsh 不是 Claude Code 系。

🔴 **永远 exit 0。** 与其它 harness 同一条规矩（BRIDGE-PROTOCOL §7.1）。
本入口是被 node 的 `spawn` 拉起来的，退出码不会拦住谁，但保持一致 ——
以后有人把它挂到别处（比如 shell hook）时不至于踩雷。
"""

import json
import os
import sys

# 同一份脚本要在两种布局下都能跑：仓库里（模块在 ../../bridge）与组装后的插件目录（模块在同级）。
_here = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_here, os.path.join(_here, "..", "..", "bridge")]
from state_machine import diagnostic, update  # noqa: E402

HARNESS = "dsh"
LABEL = "DeepSeek Harness"

# 状态机认得的内部事件（键名 `hook_event_name`，与其它 harness 一致）。
# 翻译已在 JS 侧做完，这里只挡住不认识的名字 ——
# 白名单而不是「来什么喂什么」：进来的东西直接驱动形象，不该由调用方随口决定。
KNOWN = frozenset({
    "on_session_start", "on_session_finalize", "on_session_reset",
    "pre_llm_call", "post_llm_call", "pre_tool_call", "post_tool_call",
    "subagent_start", "subagent_stop",
})


def main():
    try:
        # Windows：stdin 不一定是 UTF-8（Python 按系统代码页解码），
        # 而 PowerShell 管道还会在开头塞一个 BOM。直接读字节自己解码，两颗雷一次拆掉；
        # 坏字节换成替换符而不是抛异常 —— 解码失败不该让一整条事件丢掉。
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig", "replace"))
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        if payload.get("hook_event_name") in KNOWN:
            # 孤儿 subagent_stop 用默认的「出队最老」：dsh 的 subagent/start 与 /end 由
            # 同一个 runId 成对发出（官方类型注释），没有 CC 那种 compact 造出的孤儿。
            update(payload, LABEL, harness=HARNESS)
    except Exception as exc:
        diagnostic("dsh hook event ignored: " + str(exc))
    return 0   # 🔴 永远 0


if __name__ == "__main__":
    sys.exit(main())
