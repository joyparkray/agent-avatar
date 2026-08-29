#!/usr/bin/env python3
"""Hermes 适配层 —— shell hook 入口（fail-open，stdlib only）。

**默认接入方式是 Hermes 插件**（`plugin/agent-avatar/`，见 `docs/HERMES-SETUP.md`）：
它不需要改用户的 `config.yaml`、不需要 allowlist、不需要 `hooks_auto_accept`。
本文件是插件不可用时的退路，行为与插件完全一致 —— 两者共用
`../../bridge/state_machine.py`，看到的 payload 也是同一个形状。

这一层只做两件 Hermes 专属的事：
1. Hermes 的事件名**就是**状态机的内部词表，无需翻译（见 core 的模块注释）；
2. 顺带把 `HERMES_DASHBOARD_SESSION_TOKEN` 带出给皮肤（音频链路鉴权）。
"""

import json
import os
import sys

# 同一份脚本要在两种布局下都能跑：仓库里（模块在 ../../bridge）与组装后的插件目录（模块在同级）。
_here = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_here, os.path.join(_here, "..", "..", "bridge")]
from state_machine import diagnostic, update  # noqa: E402

LABEL = "Hermes"


def audio_block():
    """把 Hermes 的会话 token 带给皮肤（见 docs/HERMES-STATE-TAXONOMY.md）。

    拿不到时返回 None —— core 会沿用上一次的值而不是覆盖成空。
    gateway / cron 会话不是 desktop 后代，环境里本来就没有这个变量。
    """
    token = os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", "").strip()
    return {"token": token} if token else None


def main():
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        update(payload, LABEL, audio_block())
    except Exception as exc:
        diagnostic("hook event ignored: " + str(exc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
