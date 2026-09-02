#!/bin/sh
# 组装**自包含**的插件目录。
#
# 为什么需要这一步：状态机与翻译层的单一真相在 `core/`，而插件分发要求插件目录自包含 ——
# marketplace 装给用户的就是仓库里那棵树，没人替他跑 install-plugin.sh。少了 core 的话
# hook 起来 import 失败、`python3` 以退出码 2 退出，正好踩中「退出码 2 = block」那颗雷。
# 所以组装 = 把 core 拷进插件骨架，输出一棵可直接分发、也可直接安装的树。
#
# 用法：
#   assemble.sh <harness> <target>   组装一家到指定目录（install-plugin.sh 走这条）
#   assemble.sh all                  组装五家到 release/connectors/<harness>/（发布走这条）
#
# 组装完会跑一次冒烟自检：喂一条事件给**组装后的**脚本，确认它能独立跑起来并落盘。
# 自检用隔离的 TMPDIR，不碰用户真实的状态文件。
#
# 自检用哪个 python 可以用 `AGENT_AVATAR_PYTHON` 指定。默认 `python3` 在两个平台上
# 都可能不是真的 Python：macOS 干净机器上 `/usr/bin/python3` 是 Xcode 命令行工具的
# 占位程序（跑它会**弹出安装对话框**），Windows 上它是 0 字节的应用商店存根。
set -eu

python=${AGENT_AVATAR_PYTHON:-python3}

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bridge="$here/../bridge"

assemble_claude_code() {
  target=$1
  mkdir -p "$target/.claude-plugin" "$target/hooks"
  cp "$here/claude-code/plugin/agent-avatar/.claude-plugin/plugin.json" "$target/.claude-plugin/"
  cp "$here/claude-code/plugin/agent-avatar/hooks/hooks.json"           "$target/hooks/"
  cp "$here/claude-code/agent-avatar-hook.py"                           "$target/hooks/"
  cp "$bridge/state_machine.py" "$bridge/pascal_events.py"                  "$target/hooks/"
}

# 布局照官方已装插件的实际约定：hooks.json 在**插件根**（不是子目录），
# 脚本在 scripts/ 且要可执行（命令直接执行脚本，靠 shebang）。
assemble_codex() {
  target=$1
  mkdir -p "$target/.codex-plugin" "$target/scripts"
  cp "$here/codex/plugin/agent-avatar/.codex-plugin/plugin.json" "$target/.codex-plugin/"
  cp "$here/codex/plugin/agent-avatar/hooks.json"                "$target/"
  cp "$here/codex/agent-avatar-hook.py"                          "$target/scripts/"
  cp "$bridge/state_machine.py" "$bridge/pascal_events.py"           "$target/scripts/"
  chmod +x "$target/scripts/agent-avatar-hook.py"
}

# WorkBuddy 的 agent core 是随 app 分发的 CodeBuddy Code CLI，插件布局与 CC 同形，
# 但清单目录是 `.codebuddy-plugin/`（自带插件都是这个），hook 里用 ${CODEBUDDY_PLUGIN_ROOT}。
assemble_workbuddy() {
  target=$1
  mkdir -p "$target/.codebuddy-plugin" "$target/hooks"
  cp "$here/workbuddy/plugin/agent-avatar/.codebuddy-plugin/plugin.json" "$target/.codebuddy-plugin/"
  cp "$here/workbuddy/plugin/agent-avatar/hooks/hooks.json"              "$target/hooks/"
  cp "$here/workbuddy/agent-avatar-hook.py"                              "$target/hooks/"
  cp "$bridge/state_machine.py" "$bridge/pascal_events.py"                   "$target/hooks/"
}

# dsh 插件是 in-process 的 **cordis（JS）** 插件：事件翻译在 index.mjs 里，
# 它再把内部词表的 payload 喂给同级的 python 入口 —— 状态机仍然只有一份。
assemble_dsh() {
  target=$1
  mkdir -p "$target"
  cp "$here/dsh/plugin/agent-avatar/index.mjs" "$target/"
  cp "$here/dsh/agent-avatar-hook.py"          "$target/"
  cp "$bridge/state_machine.py"                  "$target/"
}

# Hermes 插件是 in-process 的 Python 包，`from .state_machine import update` 在包内解析，
# 所以 core 拷在包根。事件名就是内部词表，不需要 pascal_events。
assemble_hermes() {
  target=$1
  mkdir -p "$target"
  cp "$here/hermes/plugin/agent-avatar/plugin.yaml" "$target/"
  cp "$here/hermes/plugin/agent-avatar/__init__.py" "$target/"
  cp "$bridge/state_machine.py"                       "$target/"
}

# 冒烟自检：只验一件事 —— **组装后的目录能不能独立跑起来**（core 在不在、import 对不对）。
# 这正是漏拷 core 时的失败形状，而那种失败在真实注册里是静默的（hook 被跳过 / 一直 idle）。
smoke_test() {
  harness=$1 target=$2
  scratch=$(mktemp -d)
  # 默认喂一条「开新局」；个别 harness 覆盖（见下）
  event='{"hook_event_name":"SessionStart","source":"startup","session_id":"smoke"}' 
  case $harness in
    claude-code) script="$target/hooks/agent-avatar-hook.py"   state="agent-avatar-state.claude-code.json" ;;
    codex)       script="$target/scripts/agent-avatar-hook.py" state="agent-avatar-state.codex.json" ;;
    # WorkBuddy 的 SessionStart 不再当重置（见 pascal_events 的注释），拿它做自检永远写不出
    # 文件。改喂 UserPromptSubmit —— 那是它真实的回合起点。
    workbuddy)   script="$target/hooks/agent-avatar-hook.py"   state="agent-avatar-state.workbuddy.json"
                 event='{"hook_event_name":"UserPromptSubmit","session_id":"smoke"}' ;;
    dsh)
      # 两件事都要验：JS 插件能被 import（cordis 会 import 它），python 入口能独立落盘。
      # 路径交给 node 自己转成 file URL：手拼 `file://$path` 在 Windows 上不成立
      # （盘符会被当成主机名，报 ERR_INVALID_FILE_URL_PATH）。
      node --input-type=module -e "const {pathToFileURL} = await import('node:url'); const m = await import(pathToFileURL(process.argv[1]).href); if (typeof m.apply !== 'function') { process.exit(1) }" "$target/index.mjs" \
        || { rm -rf "$scratch"; echo "smoke test failed: dsh 的 index.mjs 导不进来或没有 apply" >&2; exit 1; }
      if ! echo '{"hook_event_name":"pre_llm_call","session_id":"smoke","turn_id":"1"}' \
        | TMPDIR="$scratch" "$python" "$target/agent-avatar-hook.py" >/dev/null; then
        rm -rf "$scratch"; echo "smoke test failed: dsh 的 python 入口非零退出" >&2; exit 1
      fi
      if [ ! -f "$scratch/agent-avatar-state.dsh.json" ]; then
        rm -rf "$scratch"; echo "smoke test failed: dsh 没写出状态文件（core 可能没拷全）" >&2; exit 1
      fi
      rm -rf "$scratch"; return 0 ;;
    hermes)
      # 包形态没有 stdin 入口，直接按包加载一次：漏拷 state_machine.py 就会在这里炸。
      TMPDIR="$scratch" "$python" - "$target" <<'PY' || { rm -rf "$scratch"; echo "smoke test failed: hermes" >&2; exit 1; }
import importlib.util, sys
target = sys.argv[1]
spec = importlib.util.spec_from_file_location(
    "agent_avatar_plugin", target + "/__init__.py", submodule_search_locations=[target])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
assert module.HOOKS, "plugin exposes no hooks"
PY
      rm -rf "$scratch"; return 0 ;;
  esac
  if ! echo "$event" | TMPDIR="$scratch" "$python" "$script" >/dev/null; then
    rm -rf "$scratch"; echo "smoke test failed: $harness 的 hook 非零退出（core 可能没拷全）" >&2; exit 1
  fi
  if [ ! -f "$scratch/$state" ]; then
    rm -rf "$scratch"; echo "smoke test failed: $harness 没写出状态文件（core 可能没拷全）" >&2; exit 1
  fi
  rm -rf "$scratch"
}

assemble() {
  harness=$1 target=$2
  case $harness in
    claude-code) assemble_claude_code "$target" ;;
    codex)       assemble_codex "$target" ;;
    hermes)      assemble_hermes "$target" ;;
    dsh)         assemble_dsh "$target" ;;
    workbuddy)   assemble_workbuddy "$target" ;;
    *) echo "unknown harness: $harness（可选：claude-code / codex / hermes / dsh / workbuddy / all）" >&2; exit 1 ;;
  esac
  smoke_test "$harness" "$target"
  echo "assembled $harness -> $target"
}

if [ "${1:-}" = "all" ]; then
  out="${2:-$here/../release/connectors}"
  for harness in hermes claude-code codex dsh workbuddy; do
    assemble "$harness" "$out/$harness/agent-avatar"
  done
  exit 0
fi

[ $# -eq 2 ] || { echo "用法：assemble.sh <harness> <target> | assemble.sh all [outdir]" >&2; exit 1; }
assemble "$1" "$2"
