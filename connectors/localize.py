#!/usr/bin/env python3
"""把插件树「本地化」到这台机器 —— Windows 上装 connector 时唯一需要的额外一步。

为什么需要这一步（只有 Windows 需要）
------------------------------------
从 marketplace clone 下来的插件对所有人是同一份，里面写的是 `python3`。
POSIX 上那就是对的，装完直接能用。**Windows 上 `python3` 不是 Python** ——
它解析到 `%LOCALAPPDATA%\\Microsoft\\WindowsApps\\python3.exe`，一个 0 字节的应用商店
存根：能启动、打印「Python was not found」、以 9009 退出。而 9009 不是 2，
不会被 harness 当成 block，所以**没有任何一处会察觉**，表现就是形象永远不动。

所以要把解释器换成这台机器上真能跑的那个绝对路径。

为什么是一条命令而不是让 agent 手改 JSON
----------------------------------------
装 connector 这件事交给 agent 做（用户本来就坐在一个能执行命令的 agent 面前），
但**改配置这一步必须是确定的**：提示词会被复制、转发、改写，只有当它退化成
「执行这条确定的命令」时，用户和我们才都能确认它做了什么。让模型逐字改 JSON
则每次结果都可能不同 —— 而这条链路上的错误是静默的。

解释器从哪来
------------
`sys.executable` —— **跑得起这个脚本的解释器，按定义就是一个能用的解释器**。
不需要探测，也不会踩到存根（存根根本跑不起来这个脚本）。

用法
----
    python localize.py <harness> [--root <插件树的根>]

`--root` 默认是脚本所在目录的 `plugins/<harness>/agent-avatar`（发布树的布局）。
"""

import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile

HARNESSES = ("claude-code", "codex", "workbuddy", "dsh", "hermes")

# 各家的入口与状态文件名。改布局时这里要跟着改，否则表现是「装完了却没动静」。
LAYOUT = {
    "claude-code": {"config": "hooks/hooks.json", "hook": "hooks/agent-avatar-hook.py",
                    "state": "agent-avatar-state.claude-code.json", "event": "UserPromptSubmit"},
    "codex": {"config": "hooks.json", "hook": "scripts/agent-avatar-hook.py",
              "state": "agent-avatar-state.codex.json", "event": "UserPromptSubmit"},
    "workbuddy": {"config": "hooks/hooks.json", "hook": "hooks/agent-avatar-hook.py",
                  "state": "agent-avatar-state.workbuddy.json", "event": "UserPromptSubmit"},
    "dsh": {"config": "index.mjs", "hook": "agent-avatar-hook.py",
            "state": "agent-avatar-state.dsh.json", "event": "pre_llm_call"},
    "hermes": {"config": None, "hook": None, "state": None, "event": None},
}


def hook_path(executable):
    """把解释器路径变成**命令行里能用**的形状。

    正斜杠：Windows API 两种分隔符都收，但 Claude Code 在 Windows 上默认走 Git Bash，
    而 bash 会把反斜杠当转义吃掉（`C:\\Python314\\python.exe` → `C:Python314python.exe`）。

    不能带空格：命令行里解释器那一段不能加引号（PowerShell 只在**首个 token** 带引号时
    把它当字符串表达式，直接报错），所以带空格的路径没法表达。
    「为所有用户安装」的默认位置 `C:\\Program Files\\PythonXXX\\` 正好带空格 ——
    这时改用 8.3 短路径，它没有空格且两种 shell 都认。
    """
    path = executable
    if " " in path and os.name == "nt":
        import ctypes
        buffer = ctypes.create_unicode_buffer(512)
        if ctypes.windll.kernel32.GetShortPathNameW(path, buffer, len(buffer)) and " " not in buffer.value:
            path = buffer.value
    return path.replace("\\", "/")


def rewrite_hooks_json(path, python, harness):
    """把 hooks.json 里每一条 command 的解释器换掉。

    写进去的那一行有严格的形状要求（逐条实测，见 private/WINDOWS-PORT.md「4.6」）：

        C:/Python314/python.exe "${CLAUDE_PLUGIN_ROOT}/hooks/agent-avatar-hook.py" ; exit 0
        └─ 正斜杠、不加引号        └─ 参数加引号（两种 shell 都认）      └─ 保险

    `; exit 0` 不能省：脚本路径万一失效，`python x.py` 的退出码**恰好是 2**，
    而 2 在 Claude Code 与 Codex 里都是 block。

    Codex 走它自己的 `commandWindows` 覆盖字段，POSIX 那条原样保留 ——
    同一份 hooks.json 两个平台通用。
    """
    with open(path, encoding="utf-8") as handle:
        document = json.load(handle)
    rewritten = 0
    for matchers in document.get("hooks", {}).values():
        for matcher in matchers:
            for hook in matcher.get("hooks", []):
                if hook.get("type") != "command":
                    continue
                source = hook.get("commandWindows") if harness == "codex" else hook.get("command")
                source = source or hook.get("command", "")
                # 只换解释器，脚本路径原样保留（含 ${PLUGIN_ROOT} 之类的占位符）
                tail = source.split(None, 1)[1] if " " in source.strip() else source
                if not tail.lstrip().startswith('"'):
                    parts = tail.strip().split(" ", 1)
                    tail = '"%s"%s' % (parts[0], (" " + parts[1]) if len(parts) > 1 else "")
                line = "%s %s" % (python, tail.strip())
                if harness == "codex":
                    hook["commandWindows"] = line
                else:
                    hook["command"] = line
                rewritten += 1
    if not rewritten:
        raise SystemExit("hooks.json 里一条 command 都没找到，布局可能变了：%s" % path)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
    return rewritten


def rewrite_index_mjs(path, python):
    """dsh 是 in-process 的 JS 插件，自己 spawn 一个 python 子进程。

    这条链路在 Windows 上是五家里**最静默**的一种坏法：stderr 被 `ignore`，
    而 `error` 事件只在 spawn 失败时触发 —— 存根却是能成功启动的。
    改的是那一行的默认值，`AGENT_AVATAR_PYTHON` 环境变量仍然优先。
    """
    import re
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    pattern = r'process\.env\.AGENT_AVATAR_PYTHON \|\| "[^"]*"'
    if not re.search(pattern, text):
        raise SystemExit("index.mjs 里找不到解释器那一行，布局可能变了：%s" % path)
    text = re.sub(pattern, 'process.env.AGENT_AVATAR_PYTHON || "%s"' % python, text)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return 1


def smoke_test(root, harness):
    """喂一条真事件，看状态文件有没有落盘。

    **必须验到落盘**，不能只验退出码：hook 的设计就是永远 exit 0（退出码 2 会 block），
    所以退出码根本反映不出它有没有干活。core 漏拷、解释器不对的表现都是
    「安静地什么都没发生」—— 这个项目踩过的坑全是这个形状。
    """
    layout = LAYOUT[harness]
    if not layout["hook"]:
        return None
    scratch = tempfile.mkdtemp(prefix="agent-avatar-localize-")
    environment = dict(os.environ, TMPDIR=scratch, TEMP=scratch, TMP=scratch,
                       PYTHONDONTWRITEBYTECODE="1")
    event = json.dumps({"hook_event_name": layout["event"], "session_id": "localize", "turn_id": "1"})
    subprocess.run([sys.executable, os.path.join(root, layout["hook"])],
                   input=event.encode("utf-8"), env=environment,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    landed = os.path.isfile(os.path.join(scratch, layout["state"]))
    import shutil
    shutil.rmtree(scratch, ignore_errors=True)
    if not landed:
        raise SystemExit("自检没通过：%s 的 hook 没写出状态文件，core 可能没拷全" % harness)
    return layout["state"]


def print_registration(harness, root=None):
    """打印要登记的那几行配置 —— **只打印，不碰任何文件**。

    为什么不直接写：这两家要改的都是**用户自己的配置文件**（Codex 的 `config.toml`
    里有模型、notify、mcp_servers；dsh 的 patch 里可能有 `!!js` 表达式）。
    让脚本去动它们，一是风险，二是那正是杀软盯上的行为形状（未签名脚本改别家配置，
    实机被卡巴删过文件）。打印出来由 agent 追加，用户在按下去之前看得见要加什么。

    仍然是「钉死的命令」：路径、格式、内容全都算好了，agent 不需要自己拼任何东西 ——
    而这条链路上最容易错的就是拼路径（Windows 上还得是 file:/// URL）。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    if harness == "codex":
        # Codex 的 marketplace 根是**含 .agents/ 的那一层**，也就是这棵树的根。
        # Windows 的 ChatGPT app 不带 CLI，所以只能手工登记进 config.toml；
        # `source` 用 TOML 的字面量字符串（单引号），反斜杠在里面不转义。
        config = os.path.join(os.environ.get("USERPROFILE") or os.path.expanduser("~"), ".codex", "config.toml")
        print("# 追加到 %s（先备份）：" % config)
        print()
        print("[marketplaces.agent-avatar]")
        print('source_type = "local"')
        print("source = '%s'" % here)
        print()
        print('[plugins."agent-avatar@agent-avatar"]')
        print("enabled = true")
        return 0
    if harness == "dsh":
        entry = os.path.join(root or os.path.join(here, "plugins", "dsh", "agent-avatar"), "index.mjs")
        # 🔴 dsh 把这个字符串当 ESM specifier 直接 import()，而 Node 会把 `C:/…` 解析成
        # scheme 为 `c:` 的 URL（ERR_UNSUPPORTED_ESM_URL_SCHEME）。必须是 file:/// URL。
        url = pathlib.Path(os.path.abspath(entry)).as_uri()
        print("# 追加到 $DSH_HOME/cordis.patch.yml（默认 %s，先备份）：" % os.path.join("~", ".dsh"))
        print("# 文件里如果只有一行 `[]`，把那一行删掉 —— 空数组后面再跟条目是非法 YAML。")
        print()
        print("# >>> agent-avatar (managed) >>>")
        print("- insert:")
        print("    - id: agent-avatar")
        print("      name: %s" % url)
        print("# <<< agent-avatar (managed) <<<")
        return 0
    print("%s 不需要额外登记：它自己的 CLI 就能装（见 README）" % harness)
    return 0


def main():
    # Windows 上 stdout 默认按系统代码页编码（简中机器是 cp936），而这条命令的输出
    # 正是要给 agent 读的 —— 管道那头拿到的会是乱码。钉成 UTF-8。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass                      # 老 Python 或已被重定向：不值得为此失败

    parser = argparse.ArgumentParser(description="把插件树本地化到这台机器（Windows 需要）")
    parser.add_argument("harness", choices=HARNESSES)
    parser.add_argument("--root", help="插件树的根，默认 plugins/<harness>/agent-avatar")
    parser.add_argument("--print-registration", action="store_true",
                        help="只打印要登记的那几行配置，不改任何文件（codex / dsh 用）")
    arguments = parser.parse_args()

    if arguments.print_registration:
        return print_registration(arguments.harness, arguments.root)

    here = os.path.dirname(os.path.abspath(__file__))
    root = arguments.root or os.path.join(here, "plugins", arguments.harness, "agent-avatar")
    if not os.path.isdir(root):
        raise SystemExit("找不到插件目录：%s" % root)

    python = hook_path(sys.executable)
    layout = LAYOUT[arguments.harness]

    if layout["config"] is None:
        # Hermes 的插件是 in-process 的 Python 包，跑在 Hermes 自己的解释器里、不 spawn 进程 ——
        # 五家里唯一不需要本地化的一家。
        print("hermes 不需要本地化（in-process Python 包，跑在 Hermes 自己的解释器里）")
        return 0

    config = os.path.join(root, layout["config"])
    if not os.path.isfile(config):
        raise SystemExit("找不到配置文件：%s" % config)

    if arguments.harness == "dsh":
        count = rewrite_index_mjs(config, python)
    else:
        count = rewrite_hooks_json(config, python, arguments.harness)

    state = smoke_test(root, arguments.harness)
    print("解释器：%s" % python)
    if python != sys.executable.replace("\\", "/"):
        print("  （原路径带空格，命令行里改用 8.3 短路径）")
    print("已改写 %d 处 -> %s" % (count, config))
    print("自检通过：喂一条事件写出了 %s" % state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
