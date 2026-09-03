#!/usr/bin/env python3
"""Claude Code adapter — event-name mapping (stdlib only).

The translation logic lives in `../../bridge/pascal_events.py` (shared by three
harnesses; see the module docstring there). This file is just the entry point
plus a choice of config table.
**DeepSeek Harness and WorkBuddy reuse this same file** (Claude Code compatible
event format).

🔴 **Must always exit 0.** Claude Code treats exit code 2 as a block:
`PreToolUse` blocks the tool, **`Stop` blocks stopping (the conversation cannot
end)**, `SubagentStop` blocks the subagent from finishing, `UserPromptSubmit`
rejects the prompt. Note that `python3 <missing file>` exits with **exactly 2** —
so always wrap the registration in `... ; exit 0` (README §2 has the measured
comparison).
"""

import json
import os
import sys

# One script has to run under two layouts: inside the repo (modules live in
# ../../bridge) and inside an assembled plugin directory (modules sit alongside).
_here = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_here, os.path.join(_here, "..", "..", "bridge")]
from pascal_events import CLAUDE_CODE, translate  # noqa: E402
from state_machine import ORPHAN_IGNORE, diagnostic, update  # noqa: E402


def main():
    try:
        # Windows: stdin is not necessarily UTF-8 (Python decodes it using the
        # system code page), and a PowerShell pipe prepends a BOM on top of that.
        # Read raw bytes and decode them ourselves to defuse both at once; bad
        # bytes become replacement characters rather than an exception — a decode
        # failure should not cost us the whole event.
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig", "replace"))
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        translated = translate(payload, CLAUDE_CODE)
        if translated is not None:
            # ORPHAN_IGNORE: /compact emits an orphan SubagentStop whose id was
            # never announced. Hermes's "dequeue the oldest" rule would evict a
            # subagent that is genuinely still running.
            update(translated, CLAUDE_CODE["label"], orphan_subagent_stop=ORPHAN_IGNORE,
                   harness=CLAUDE_CODE["id"])
    except Exception as exc:
        diagnostic("hook event ignored: " + str(exc), CLAUDE_CODE["id"])
    return 0  # never return 2 — see the module docstring


if __name__ == "__main__":
    sys.exit(main())
