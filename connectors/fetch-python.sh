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

# macOS 没有官方的 embeddable 包，用 astral-sh/python-build-standalone 的 install_only
# 那一档（PyTauri 用的也是它）。两个数字都要钉死：发布 tag 和 Python 版本 —— 它们是一对，
# 换任何一个都可能 404。2026-09-03 两个架构都用 HEAD 验过，各 24 MB 左右。
#
# 与 Windows 那份的补丁号不同（3.13.7 vs 3.13.15）是无所谓的：connector 只用标准库，
# 而两边都是 3.13。硬要对齐反而会让某一边取不到。
MACOS_TAG=20260901
MACOS_VERSION=3.13.15

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
    # 架构要跟**构建目标**走，不是跟这台机器走 —— Apple Silicon 和 Intel 是分开出包的。
    # 交叉构建时用 AGENT_AVATAR_PYTHON_ARCH 指定。
    arch=${AGENT_AVATAR_PYTHON_ARCH:-$(uname -m 2>/dev/null || echo arm64)}
    case "$arch" in
      arm64|aarch64) arch=aarch64 ;;
      x86_64|amd64)  arch=x86_64 ;;
      *) echo "不认得的架构：$arch（用 AGENT_AVATAR_PYTHON_ARCH 指定 aarch64 或 x86_64）" >&2; exit 1 ;;
    esac
    # `+` 在 URL 里要写成 %2B，否则会被当成空格
    url="https://github.com/astral-sh/python-build-standalone/releases/download/$MACOS_TAG/cpython-$MACOS_VERSION%2B$MACOS_TAG-$arch-apple-darwin-install_only.tar.gz"
    archive=$out/.python-macos.tar.gz
    echo "fetching $url"
    command -v curl >/dev/null 2>&1 || { echo "need curl to fetch the interpreter" >&2; exit 1; }
    curl -fsSL -o "$archive" "$url"

    # 包里最外层就叫 `python/`，正好是我们要的目录名，所以解到上一层再让它落位。
    rm -rf "$target"
    staging=$out/.python-staging
    rm -rf "$staging"; mkdir -p "$staging"
    tar -xzf "$archive" -C "$staging"
    [ -d "$staging/python" ] || { echo "解出来的结构和预期不符（没有 python/）" >&2; exit 1; }
    mv "$staging/python" "$target"
    rm -rf "$staging" "$archive"

    # 🔴 **签名。** 这份解释器是下载来的，没有我们的签名；Gatekeeper 不会让一个没签过的
    # 可执行文件在别人机器上跑起来，而症状还是那个老形状 —— 装好了，形象不动。
    # app 的公证会覆盖它，但前提是它先被**逐个二进制**签过（hardened runtime）。
    if [ "${AGENT_AVATAR_CODESIGN_IDENTITY:-}" != "" ]; then
      echo "codesigning the bundled interpreter"
      find "$target" -type f \( -name '*.dylib' -o -name '*.so' -o -perm -u+x \) -print0 2>/dev/null |
        xargs -0 -I{} codesign --force --timestamp --options runtime \
          --sign "$AGENT_AVATAR_CODESIGN_IDENTITY" {} >/dev/null
    else
      echo "⚠️  未签名：设 AGENT_AVATAR_CODESIGN_IDENTITY 后重跑，否则打出来的包在别人机器上跑不起来" >&2
    fi

    "$target/bin/python3" -c "import json,os,sys,time,tempfile,shlex,re,datetime,fcntl,pathlib,subprocess,io; print('bundled python', sys.version.split()[0], 'stdlib OK')"
    ;;
  *)
    echo "unknown platform: $platform" >&2; exit 1 ;;
esac

echo "bundled python -> $target"
