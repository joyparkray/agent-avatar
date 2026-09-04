#!/bin/sh
# 选一个**真的能跑**的 Python 3。被 assemble.sh 与 build-bundle.sh 共同 source。
#
# 🔴 **`python3` 这个名字在两个平台上都可能不是 Python。** 两处都实测撞到过：
#
# - Windows：`python3` 解析到 `%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe`，
#   一个应用商店存根。它**不报错**，而是打印一句「Python was not found; run without
#   arguments to install from the Microsoft Store」然后以退出码 49 退出。
# - macOS：干净机器上 `/usr/bin/python3` 是 Xcode 命令行工具的占位程序。
#
# 所以不能只看「命令在不在」，要**跑一下**确认它是 Python 3。判据是让它自己回答版本，
# 而不是解析它打印了什么 —— 存根打印的内容我们不该去猜。
#
# 顺序是 `python3` 优先：在 python3 正常的机器上（Mac 与大多数 Linux）行为与从前一字不差，
# 不会因为这次改动去挑一个不同的解释器。

# 一个候选能不能用。安静地跑，存根那句话不该出现在构建输出里。
_python_works() {
  [ -n "$1" ] || return 1
  "$1" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1
}

# 打印选中的解释器；一个都不行就报错退出。
pick_python() {
  # 用户明确指定的**不做兜底**：他指了一个坏的，应该当场知道，而不是拿另一个悄悄替上。
  if [ -n "${AGENT_AVATAR_PYTHON:-}" ]; then
    if _python_works "$AGENT_AVATAR_PYTHON"; then
      printf '%s\n' "$AGENT_AVATAR_PYTHON"
      return 0
    fi
    echo "AGENT_AVATAR_PYTHON=$AGENT_AVATAR_PYTHON 不是一个能跑的 Python 3" >&2
    return 1
  fi
  # `py` 是 Windows 官方的版本启动器，装了真 Python 的机器上它一定在
  for candidate in python3 python py; do
    if _python_works "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "找不到能跑的 Python 3（试过 python3、python、py）。" >&2
  echo "Windows 上 \`python3\` 通常是应用商店的存根，请装一个真的 Python 3，" >&2
  echo "或用 AGENT_AVATAR_PYTHON=<解释器> 指定。" >&2
  return 1
}
