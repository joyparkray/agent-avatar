#!/bin/sh
# 把 Agent Avatar 装成 Claude Code 插件。
#
# 为什么是插件而不是直接改 ~/.claude/settings.json：
#   - 用户用 `/plugin` 就能开关，不用手改自己的 settings；
#   - hook 命令用 ${CLAUDE_PLUGIN_ROOT} 定位，**路径不会因为仓库被移动而失效** ——
#     那类失效会让脚本以退出码 2 退出，而 Claude Code 把退出码 2 当作 block
#     （PreToolUse 拦工具、Stop 让对话停不下来）；
#   - 与 Hermes / Codex 的接入方式一致，用户只需要理解一个概念。
#
# 组装到 $target 而不是直接用仓库目录：插件必须**自包含**（hook 脚本 + core 两个模块），
# 而状态机的单一真相在 ../../bridge/，不该在仓库里放副本。组装本身交给 ../assemble.sh
# （五家共用，发布时的 `assemble.sh all` 走的是同一条路径）。
#
# 卸载：/plugin 里禁用，然后删掉 "$target"
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/local/agent-avatar"

# 组装（拷 bridge core 进插件目录 + 冒烟自检）五家共用，见 ../assemble.sh
"$here/../assemble.sh" claude-code "$target"
echo
echo "开发期直接加载（不安装，改完 /reload-plugins 即可）："
echo "  claude --plugin-dir $target"
echo
echo "或注册成本地 marketplace 长期使用："
echo "  claude plugin marketplace add $target"
echo
echo "⚠️ 装好后请从 ~/.claude/settings.json 里删掉手工注册的 agent-avatar-hook 条目，"
echo "   否则两条链路会对同一个状态文件重复记账。"
