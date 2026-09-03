#!/bin/sh
# Fetch the Python the app ships, into the bundle.
#
# Why the app carries an interpreter at all: "there is no usable Python on this machine"
# is the **quietest** failure this project has. On Windows `python3` resolves to a 0-byte
# Microsoft Store stub that starts, prints "Python was not found" and exits 9009 — and
# 9009 is not 2, so no harness treats it as a block. Nothing anywhere notices; the only
# symptom is an avatar that never moves. macOS is no better: `/usr/bin/python3` is a
# Command Line Tools placeholder that pops an install dialog on a clean machine.
#
# Shipping one removes that entire class, and makes the hook command line point at a
# path we control — so "find an interpreter that works on this machine" collapses into
# "write the one we brought".
#
# 🔴 Why not compile the hook natively instead (2 MB rather than 21, and ~2 ms of
# start-up per event rather than ~50): the Hermes plugin is an **in-process Python
# package** that runs inside Hermes's own interpreter, so that one has to stay Python.
# A native build for the other four would mean two implementations of the state machine,
# and the state machine is the contract with the app — a fork there shows up as "the
# avatar displayed the wrong state", which nobody notices for weeks.
#
# Usage: fetch-python.sh [outdir]    default: ../desktop/src-tauri/resources/connectors
#        AGENT_AVATAR_PYTHON_PLATFORM=windows|macos   (default: this machine)
set -eu

# Pin the version. An interpreter that changes under us is a change to every hook
# command line we have already written into five harnesses' configs.
WINDOWS_VERSION=3.13.7
WINDOWS_URL="https://www.python.org/ftp/python/$WINDOWS_VERSION/python-$WINDOWS_VERSION-embed-amd64.zip"

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=${1:-$here/../desktop/src-tauri/resources/connectors}
mkdir -p "$out"
out=$(CDPATH= cd -- "$out" && pwd)

platform=${AGENT_AVATAR_PYTHON_PLATFORM:-}
if [ -z "$platform" ]; then
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*|Windows_NT) platform=windows ;;
    Darwin) platform=macos ;;
    *) platform=windows ;;
  esac
fi

target=$out/python
if [ -x "$target/python.exe" ] || [ -x "$target/bin/python3" ]; then
  echo "python already in $target (delete it to refetch)"
  exit 0
fi

case "$platform" in
  windows)
    # The official "embeddable" zip: interpreter, the standard library as a zip, and the
    # pyd extension modules. Measured 2026-09-03: 10.9 MB compressed, 21 MB unpacked,
    # and every module the connector imports is present (json, os, sys, time, tempfile,
    # shlex, re, datetime, msvcrt, pathlib, argparse, subprocess, calendar, io). All
    # four spawn-based hooks were fed a real event under it and the state file landed.
    archive=$out/.python-embed.zip
    echo "fetching $WINDOWS_URL"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL -o "$archive" "$WINDOWS_URL"
    else
      echo "need curl to fetch the interpreter" >&2; exit 1
    fi
    rm -rf "$target"
    mkdir -p "$target"
    # Unpacked with Python rather than unzip: Git Bash has no unzip, and the build
    # already depends on a Python for assemble.sh.
    AGENT_AVATAR_ARCHIVE=$archive AGENT_AVATAR_TARGET=$target \
      "${AGENT_AVATAR_PYTHON:-python3}" - <<'PY'
import os, zipfile
zipfile.ZipFile(os.environ["AGENT_AVATAR_ARCHIVE"]).extractall(os.environ["AGENT_AVATAR_TARGET"])
PY
    rm -f "$archive"
    "$target/python.exe" -c "import json,os,sys,time,tempfile,shlex,re,datetime,msvcrt,pathlib,subprocess,io; print('bundled python', sys.version.split()[0], 'stdlib OK')"
    ;;
  macos)
    # 🔴 **还没实现，而且是故意显式失败的** —— 不能悄悄退回系统那个解释器，
    # 因为 macOS 上 `/usr/bin/python3` 正是我们要消灭的那个占位程序（没装 Xcode 命令行
    # 工具时它会弹安装框），静默退回等于把这个脚本存在的理由抵消掉。
    #
    # 方案定了：astral-sh/python-build-standalone 的 install_only 包（PyTauri 用的就是它）。
    # 命名规则已经实测过（2026-09-03，用一个已知的老版本验的，返回 200）：
    #
    #   https://github.com/astral-sh/python-build-standalone/releases/download/<TAG>/
    #     cpython-<版本>+<TAG>-<aarch64|x86_64>-apple-darwin-install_only.tar.gz
    #
    #   （URL 里那个 `+` 要写成 %2B）
    #
    # 在 Mac 上补完它要做三件事：
    #
    #   1. 挑一对确实存在的 <TAG>/<版本>，用 HEAD 请求验一下：
    #        curl -sIL -o /dev/null -w '%{http_code}' "<上面那个 URL>"    # 期望 200
    #      **必须钉死**，不能用 latest —— 解释器一换，就等于改了我们已经写进五家 harness
    #      配置里的每一条 hook 命令行。
    #   2. 两个架构都要（Apple Silicon 与 Intel），或者只出 universal 的那份。
    #   3. 跟 app 一起签名公证。**这一条不能漏**：没公证的解释器在别人机器上跑不起来，
    #      而症状还是那个老形状 —— 装好了，形象不动。
    #
    # 做完之后照 Windows 那一支的样子跑一遍自检（import 一遍我们用到的标准库）。
    echo "macOS interpreter bundling is not implemented yet — see the recipe in this script" >&2
    exit 2
    ;;
  *)
    echo "unknown platform: $platform" >&2; exit 1 ;;
esac

echo "bundled python -> $target"
