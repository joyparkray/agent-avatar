#!/bin/sh
# 把 Agent Avatar 装成 Codex 插件（ChatGPT app / Codex CLI 通用）。
#
# 为什么是插件而不是直接改 hooks.json：
#   - 用户在 app 的 Plugins 标签页里就能开关，不用手改配置文件；
#   - hook 命令用 ${PLUGIN_ROOT} 定位，**路径不会因为仓库被移动而失效** ——
#     那类失效会让脚本以退出码 2 退出，而 Codex 把退出码 2 当作 block，直接拦死工具调用；
#   - 插件同时被 ChatGPT app 与 Codex CLI 发现（统一插件目录）。
#
# 卸载：codex plugin remove agent-avatar  然后删掉 "$CODEX_HOME/plugins/agent-avatar"
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
codex_home="${CODEX_HOME:-$HOME/.codex}"
target="$codex_home/plugins/agent-avatar"
marketplace="${AGENTS_HOME:-$HOME/.agents}/plugins/marketplace.json"

# 布局照官方已装插件（Figma / Replay.io）的实际约定，不是照构建文档：
#   - `hooks.json` 在**插件根目录**，不是子目录；
#   - `plugin.json` **不带**顶层 `hooks` 字段（当前 validator 不接受）；
#   - hook 命令用相对插件根的路径（Figma 用的就是 `./scripts/xxx.sh`）。
# 我们最初照官方构建文档写成「顶层 hooks 字段 + hooks/hooks.json」，codex-cli 能加载，
# 但 ChatGPT app 的 validator 不认，表现为插件已启用却完全不触发。实物约定胜过文档。
# 幂等：清掉本插件早期布局留下的 `hooks/` 子目录。留着的话那份 stale `hooks/hooks.json`
# 会和根目录的新版并存，可能被重复加载或让 validator 困惑。
# 只删我们自己创建过的这一个子目录，不碰插件目录里的其它东西。
python3 - "$target" <<'PY'
import os, shutil, sys
stale = os.path.join(sys.argv[1], "hooks")
if os.path.isdir(stale):
    shutil.rmtree(stale)
    print("removed stale layout:", stale)
PY

# 组装（布局 + 拷 bridge core + chmod + 冒烟自检）五家共用，见 ../assemble.sh
"$here/../assemble.sh" codex "$target"

mkdir -p "$(dirname "$marketplace")"
python3 - "$marketplace" "$target" <<'PY'
import json, os, shutil, sys
path, plugin_dir = sys.argv[1], sys.argv[2]

# marketplace root = 含 `.agents/` 的那一层（`<root>/.agents/plugins/marketplace.json`）。
# 官方：「Codex resolves source.path relative to the marketplace root」，且路径必须以 `./`
# 开头、留在 root 内。**给绝对路径会被静默丢弃** —— 表现为插件在列表里根本不出现，
# 不报错（实测撞到过，2026-08-28）。
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(path))))
relative = os.path.relpath(os.path.abspath(plugin_dir), root)
if relative.startswith(".."):
    sys.exit(f"插件目录必须在 marketplace root ({root}) 之内，当前在 {plugin_dir}")
relative = "./" + relative

doc = {"name": "local", "interface": {"displayName": "Local plugins"}, "plugins": []}
if os.path.exists(path):
    shutil.copyfile(path, path + ".bak-agent-avatar")      # 用户文件，先备份
    try:
        loaded = json.load(open(path))
        if isinstance(loaded, dict) and isinstance(loaded.get("plugins"), list):
            doc = loaded                                # 保留用户已有的其它条目
    except ValueError:
        pass                                            # 坏文件就当空的，不去猜它的内容
entry = {"name": "agent-avatar",
         "source": {"source": "local", "path": relative},
         "policy": {"installation": "AVAILABLE"},
         "category": "Productivity"}
doc["plugins"] = [p for p in doc["plugins"] if p.get("name") != "agent-avatar"] + [entry]
with open(path, "w", encoding="utf-8") as out:
    json.dump(doc, out, indent=2, ensure_ascii=False)
print(f"marketplace -> {path}\n  root={root}\n  path={relative}")
PY

echo "files -> $target"
echo
# 让插件从「发现」变成「已安装并启用」。marketplace 里只是登记，还要 add 一次。
if command -v codex >/dev/null 2>&1; then
  codex plugin add agent-avatar@local || echo "（codex plugin add 失败，可稍后手动执行）"
fi
echo
echo "接着："
echo "  1) 重启 ChatGPT app（插件在启动时被发现）"
echo "  2) 在 Plugins 标签页里确认 Agent Avatar 已启用"
echo "  3) **审阅并信任它的 hooks** —— 启用插件不会自动信任 hooks，"
echo "     Codex 会一直跳过未信任的 hook。这是安全设计，不是故障。"
