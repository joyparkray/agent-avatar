#!/usr/bin/env python3
"""WorkBuddy adapter — event-name mapping (stdlib only).

The translation logic lives in `../../bridge/pascal_events.py` (shared by the
Claude Code family; see the module docstring there). This file is just the entry
point plus a choice of config table.

WorkBuddy's agent core is the **CodeBuddy Code CLI** shipped inside the app
(v2.115.0 on the machine we tested). Its hook vocabulary is identical to Claude
Code's. The two differences live in the config table: there is no turn field (we
fall back to the session), and SessionStart arrives late (so it is not treated as
a reset). Verified on real hardware 2026-08-28; see the README.

🔴 **Must always exit 0.** Same CLI, same rule: exit code 2 blocks the tool call.
Note that `python3 <missing file>` exits with **exactly 2** — so always wrap the
registration in `... ; exit 0` (README §2 has the measured comparison).
"""

import json
import os
import sys

# One script has to run under two layouts: inside the repo (modules live in
# ../../bridge) and inside an assembled plugin directory (modules sit alongside).
_here = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_here, os.path.join(_here, "..", "..", "bridge")]
from pascal_events import WORKBUDDY, translate  # noqa: E402
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
        translated = translate(payload, WORKBUDDY)
        if translated is not None:
            # ORPHAN_IGNORE: /compact emits an orphan SubagentStop whose id was
            # never announced. Hermes's "dequeue the oldest" rule would evict a
            # subagent that is genuinely still running.
            update(translated, WORKBUDDY["label"], orphan_subagent_stop=ORPHAN_IGNORE,
                   harness=WORKBUDDY["id"])
    except Exception as exc:
        diagnostic("hook event ignored: " + str(exc), WORKBUDDY["id"])
    return 0  # never return 2 — see the module docstring


if __name__ == "__main__":
    sys.exit(main())
