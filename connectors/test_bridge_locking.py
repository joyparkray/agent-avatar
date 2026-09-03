"""Regression test for the bridge's cross-process lock.

**Why this exists**: `state_machine.update()` is a read-modify-write — read the
`.sessions` bookkeeping, run the state machine, write bookkeeping and snapshot back.
Hooks are separate processes, and an agent running tools in parallel or spawning
subagents starts **several at once**, all contending for the same pair of files for
one harness. Without a lock they overwrite each other: what is lost is bookkeeping,
so the state machine computes a wrong state and the avatar wedges — **with no error
anywhere**.

The original implementation only had `fcntl` (Unix-only), so on Windows the import
failed and the code degraded to an unlocked write: a silent bad path. Both platforms
now have their own lock, and this test runs on both.

**The invariant**: `final snapshot sequence == number of successful writes`.
`sequence` is read from the previous snapshot and incremented, so every successful
write raises it by exactly 1. Events that cannot get the lock are **dropped** (by
design: bounded wait, and dropping one event beats stalling the agent's main loop),
and a drop prints "state file busy" on stderr, so they can be counted.

Without a lock, two processes read the same sequence and both write +1 — two events
raise it by 1, the final sequence ends up **lower** than the number of successes, and
this assertion goes red.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent.parent / "bridge"

# How many events each worker sends. Process startup costs tens of milliseconds while
# one write is sub-millisecond — with a single event each, the processes would naturally
# miss each other and even an unlocked write would pass. Give each a run of events so
# that once they are all up there is a long enough overlap window.
WORKERS = 4
EVENTS_PER_WORKER = 25

WORKER = r"""
import sys, os
sys.path.insert(0, sys.argv[1])
import state_machine

state_path = sys.argv[2]
count = int(sys.argv[3])
os.environ["AGENT_AVATAR_STATE_PATH"] = state_path
for index in range(count):
    state_machine.update(
        {"hook_event_name": "pre_llm_call", "session_id": "s%d" % index, "turn_id": "t%d" % index},
        "Test",
    )
"""


def test_concurrent_hooks_never_lose_an_update(tmp_path):
    state_path = tmp_path / "agent-avatar-state.json"
    worker_file = tmp_path / "worker.py"
    worker_file.write_text(WORKER, encoding="utf-8")

    processes = [
        subprocess.Popen(
            [sys.executable, str(worker_file), str(BRIDGE), str(state_path), str(EVENTS_PER_WORKER)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        for _ in range(WORKERS)
    ]
    dropped = 0
    for process in processes:
        _, stderr = process.communicate(timeout=120)
        assert process.returncode == 0, stderr
        dropped += stderr.count("state file busy")

    attempted = WORKERS * EVENTS_PER_WORKER
    written = attempted - dropped
    snapshot = json.loads(state_path.read_text(encoding="utf-8"))

    # The core assertion: every successful write raises sequence by exactly 1, and not one
    # of them may be lost
    assert snapshot["sequence"] == written, (
        "concurrent writes lost updates: %d attempted, %d refused by the lock, "
        "%d should have been written, sequence=%d"
        % (attempted, dropped, written, snapshot["sequence"])
    )
    # Also confirm what landed is complete JSON and that no temp file was left behind
    assert snapshot["state"] in ("idle", "writing", "reviewing")
    assert not list(tmp_path.glob(".agent-avatar-state-*"))


def test_the_lock_is_bounded_and_never_blocks_forever(tmp_path):
    """The lock must be a **bounded** wait.

    The Hermes plugin path runs in-process with no timeout to fall back on (a shell hook
    at least has `timeout: 5`), so a blocking lock would wedge the agent's main loop
    outright. When the lock cannot be had, give up within LOCK_TIMEOUT_SECONDS and drop
    the event rather than waiting forever.
    """
    sys.path.insert(0, str(BRIDGE))
    import state_machine

    state_path = tmp_path / "agent-avatar-state.json"
    os.environ["AGENT_AVATAR_STATE_PATH"] = str(state_path)
    lock_path = str(state_path) + ".lock"
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)

    # Another process holds the lock the whole time
    holder_file = tmp_path / "holder.py"
    holder_file.write_text(
        "import sys, time\n"
        "sys.path.insert(0, sys.argv[1])\n"
        "import state_machine\n"
        "handle = open(sys.argv[2], 'a+', encoding='utf-8')\n"
        "assert state_machine.acquire_lock(handle) is True\n"
        "print('held', flush=True)\n"
        "time.sleep(30)\n",
        encoding="utf-8",
    )
    holder = subprocess.Popen(
        [sys.executable, str(holder_file), str(BRIDGE), lock_path],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        assert holder.stdout.readline().strip() == "held"
        started = time.monotonic()
        state_machine.update({"hook_event_name": "pre_llm_call", "session_id": "s1", "turn_id": "t1"}, "Test")
        elapsed = time.monotonic() - started
        # Give up decisively: allow generous slack over the timeout, but never "wait forever"
        assert elapsed < state_machine.LOCK_TIMEOUT_SECONDS * 3, "waited too long for the lock: %.2fs" % elapsed
        # The event was dropped, so no snapshot should exist at all
        assert not state_path.exists()
    finally:
        holder.kill()
        holder.wait(timeout=10)
        os.environ.pop("AGENT_AVATAR_STATE_PATH", None)
