#!/usr/bin/env python3
"""取样器：把 harness 喂进来的 stdin 原样记一行，然后**永远 exit 0**。

接一家新 harness 的第一步（BRIDGE-PROTOCOL §6.1）：先实抓一轮，再写代码。
这个项目里「照官方文档写」已经错过三次 —— CC 的 `prompt_id`、Codex 的顶层 `hooks`
字段、Codex 的子代理事件，全是抓完才发现和文档不一样。

用法：按目标 harness 的注册格式，把每个事件的命令都写成
    python3 /绝对路径/sample-stdin.py ; exit 0
跑一轮真实会话（**用 `sleep 4` 这类慢工具**，快工具的 executing 只有几毫秒），然后看：
    python3 -m json.tool < "$TMPDIR/agent-avatar-stdin-sample.jsonl"   # 或直接 cat
要盯的四件事：事件名、`session_id` 与回合字段（`prompt_id`? `turn_id`?）、
子代理身份字段、以及 `SessionStart` 的 `source` 取值。

输出路径可用 AGENT_AVATAR_SAMPLE 覆盖。**stdout 保持为空**（§7.4）。
"""

import json
import os
import sys
import tempfile
import time

def main():
    try:
        raw = sys.stdin.read()
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {"_unparsed": raw[:4000]}
        path = os.getenv("AGENT_AVATAR_SAMPLE") or os.path.join(
            tempfile.gettempdir(), "agent-avatar-stdin-sample.jsonl")
        # 只追加、不覆盖：一轮会话是几十条事件，顺序本身就是要看的东西
        with open(path, "a", encoding="utf-8") as sink:
            sink.write(json.dumps({"_at": time.time(), "_argv": sys.argv[1:], **payload},
                                  ensure_ascii=False) + "\n")
    except Exception as exc:                       # 取样器绝不能把 agent 搞坏
        print("sample-stdin: " + str(exc), file=sys.stderr)
    return 0   # 🔴 永远 0 —— 退出码 2 会被当作 block（§7.1）

if __name__ == "__main__":
    sys.exit(main())
