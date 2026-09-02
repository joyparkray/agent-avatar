#!/usr/bin/env python3
"""Codex 适配层 —— 事件名映射（stdlib only）。

翻译逻辑在 `../../bridge/pascal_events.py`（三家共用，见那里的模块注释）。
本文件只是入口 + 选一份配置。

🔴 **必须永远 exit 0。** Codex 把退出码 2 当 block，范围比 Claude Code **更大** ——
`PreToolUse` / **`PostToolUse`** / `PermissionRequest` / `UserPromptSubmit` / `Stop` / `SubagentStop` 全在内
（CC 在 PostToolUse 上是忽略的，Codex 不忽略）。
注意 `python3 <不存在的文件>` 的退出码**恰好是 2** —— 所以注册时务必用
`... ; exit 0` 包一层（README §2 有实测对照）。
"""

import json
import os
import sys

# 同一份脚本要在两种布局下都能跑：仓库里（模块在 ../../bridge）与组装后的插件目录（模块在同级）。
_here = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_here, os.path.join(_here, "..", "..", "bridge")]
from pascal_events import CODEX, translate  # noqa: E402
from state_machine import ORPHAN_IGNORE, diagnostic, update  # noqa: E402


def main():
    try:
        # Windows：stdin 不一定是 UTF-8（Python 按系统代码页解码），
        # 而 PowerShell 管道还会在开头塞一个 BOM。直接读字节自己解码，两颗雷一次拆掉；
        # 坏字节换成替换符而不是抛异常 —— 解码失败不该让一整条事件丢掉。
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig", "replace"))
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        translated = translate(payload, CODEX)
        if translated is not None:
            # ORPHAN_IGNORE：compact 会发一条 ID 从没出现过的孤儿 SubagentStop。
            # Hermes 的「出队最老」在这里会踢掉一个真正在跑的子代理。
            update(translated, CODEX["label"], orphan_subagent_stop=ORPHAN_IGNORE,
                   harness=CODEX["id"])
    except Exception as exc:
        diagnostic("hook event ignored: " + str(exc), CODEX["id"])
    return 0  # 绝不返回 2 —— 见模块注释


if __name__ == "__main__":
    sys.exit(main())
