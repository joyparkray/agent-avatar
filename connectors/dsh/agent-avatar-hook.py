#!/usr/bin/env python3
"""Python entry point of the DeepSeek Harness adapter — internal payload → state machine.

Event translation for dsh happens in the sibling `plugin/agent-avatar/index.mjs`
(an in-process cordis plugin, so it can read dsh's objects directly). This file
does exactly one thing: hand a payload that is *already* in the internal
vocabulary to the shared state machine. That is why there is no `pascal_events`
import here — dsh is not part of the Claude Code family.

🔴 **Always exit 0.** Same rule as every other harness (BRIDGE-PROTOCOL §7.1).
This entry point is spawned by node, so its exit code blocks nobody today, but
keeping the rule uniform means nobody gets bitten when it is later wired
somewhere that does care (a shell hook, say).
"""

import json
import os
import sys

# One script has to run under two layouts: inside the repo (modules live in
# ../../bridge) and inside an assembled plugin directory (modules sit alongside).
_here = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_here, os.path.join(_here, "..", "..", "bridge")]
from state_machine import diagnostic, update  # noqa: E402

HARNESS = "dsh"
LABEL = "DeepSeek Harness"

# Internal events the state machine understands (key `hook_event_name`, same as
# every other harness). Translation already happened on the JS side, so all we do
# here is reject names we don't know — an allowlist rather than "forward whatever
# arrives": what comes through drives the avatar directly, and that should not be
# up to whoever happens to be calling.
KNOWN = frozenset({
    "on_session_start", "on_session_finalize", "on_session_reset",
    "pre_llm_call", "post_llm_call", "pre_tool_call", "post_tool_call",
    "subagent_start", "subagent_stop",
})


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
        if payload.get("hook_event_name") in KNOWN:
            # Orphan subagent_stop keeps the default "dequeue the oldest" rule:
            # dsh emits subagent/start and /end in pairs keyed by the same runId
            # (per its own type annotations), so it has no orphans of the kind
            # Claude Code's /compact produces.
            update(payload, LABEL, harness=HARNESS)
    except Exception as exc:
        diagnostic("dsh hook event ignored: " + str(exc), HARNESS)
    return 0   # 🔴 always 0


if __name__ == "__main__":
    sys.exit(main())
