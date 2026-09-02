"""bridge 的跨进程锁回归测试。

**为什么要有这条**：`state_machine.update()` 是一次读-改-写 ——
读 `.sessions` 记账 → 过状态机 → 写回记账与快照。而 hook 是独立进程，
agent 并行调工具或开子代理时会**同时起好几个**，抢同一家的同一组文件。
没有锁就会互相覆盖：丢的是记账，结果是状态机算出错误状态、形象卡住，**而且不报错**。

原来的实现只有 `fcntl`（Unix 专属），Windows 上 import 失败即退化成无锁写入，
是条静默的坏路径。现在两个平台各有各的锁，这条测试在两边都要跑。

**不变量**：`快照最终的 sequence == 成功写入的次数`。
`sequence` 是从上一次的快照里读出来 +1 的，所以每成功写一次恰好涨 1。
拿不到锁的事件会被**丢弃**（设计如此：有界等待，宁可丢一个事件也不卡住 agent 主循环），
丢弃时会往 stderr 打一行 "state file busy"，所以可以数出来。

没有锁的话，两个进程会读到同一个 sequence 各自写 +1 —— 两次事件只涨 1，
最终 sequence 会**小于**成功次数，这条断言就红。
"""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent.parent / "bridge"

# 每个工人跑多少次。进程启动本身要几十毫秒，而一次写是亚毫秒级 ——
# 只跑一次的话几个进程会自然错开，无锁也测不出问题。让它们各自跑一串，
# 启动完之后就有足够长的重叠窗口。
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

    # 核心断言：每一次成功写入恰好把 sequence 涨 1，一次都不能丢
    assert snapshot["sequence"] == written, (
        "并发写丢了更新：尝试 %d 次、被锁挡掉 %d 次，本应写成 %d，实际 sequence=%d"
        % (attempted, dropped, written, snapshot["sequence"])
    )
    # 顺带确认落盘的确实是完整 JSON，且没留下临时文件
    assert snapshot["state"] in ("idle", "writing", "reviewing")
    assert not list(tmp_path.glob(".agent-avatar-state-*"))


def test_the_lock_is_bounded_and_never_blocks_forever(tmp_path):
    """锁必须是**有界等待**。

    Hermes 的插件路径是 in-process 且没有超时兜底（shell hook 至少还有 `timeout: 5`），
    阻塞式的锁会把 agent 主循环直接卡死。所以拿不到锁时要在 LOCK_TIMEOUT_SECONDS
    之内放弃并丢掉这个事件，而不是一直等。
    """
    sys.path.insert(0, str(BRIDGE))
    import state_machine

    state_path = tmp_path / "agent-avatar-state.json"
    os.environ["AGENT_AVATAR_STATE_PATH"] = str(state_path)
    lock_path = str(state_path) + ".lock"
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)

    # 另一个进程一直占着锁
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
        # 放弃得干脆：给超时值留一倍余量，但绝不能是「一直等」
        assert elapsed < state_machine.LOCK_TIMEOUT_SECONDS * 3, "等锁等太久了：%.2fs" % elapsed
        # 事件被丢掉了，所以快照根本不该出现
        assert not state_path.exists()
    finally:
        holder.kill()
        holder.wait(timeout=10)
        os.environ.pop("AGENT_AVATAR_STATE_PATH", None)
