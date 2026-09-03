#!/usr/bin/env python3
"""Hermes adapter — shell hook entry point (fail-open, stdlib only).

**The default way to connect Hermes is the plugin** (`plugin/agent-avatar/`, see
`docs/HERMES-SETUP.md`): it needs no edits to the user's `config.yaml`, no
allowlist and no `hooks_auto_accept`. This file is the fallback for when the
plugin is not available, and behaves identically — both share
`../../bridge/state_machine.py` and see the same payload shape.

This layer only does the two things that are specific to Hermes:
1. Hermes's event names **are** the state machine's internal vocabulary, so no
   translation is needed (see the core module docstring);
2. it passes `HERMES_DASHBOARD_SESSION_TOKEN` through to the skin (used to
   authenticate the audio link).
"""

import json
import os
import sys

# One script has to run under two layouts: inside the repo (modules live in
# ../../bridge) and inside an assembled plugin directory (modules sit alongside).
_here = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_here, os.path.join(_here, "..", "..", "bridge")]
from state_machine import diagnostic, update  # noqa: E402

LABEL = "Hermes"


def audio_block():
    """Pass Hermes's session token to the skin (see docs/HERMES-STATE-TAXONOMY.md).

    Returns None when there is nothing to pass — the core then keeps the previous
    value instead of overwriting it with an empty one. Gateway and cron sessions
    are not descendants of the desktop process, so the variable is simply absent
    in their environment.
    """
    token = os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", "").strip()
    return {"token": token} if token else None


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
        update(payload, LABEL, audio_block())
    except Exception as exc:
        diagnostic("hook event ignored: " + str(exc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
