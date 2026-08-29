#!/bin/sh
# 把 Agent Avatar 的 Hermes 插件装进 ~/.hermes/plugins/agent-avatar/。
#
# 只往插件目录里写三个文件，**不碰用户的 config.yaml**。
# 卸载：hermes plugins disable agent-avatar && rm -rf "$HERMES_HOME/plugins/agent-avatar"
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target="${HERMES_HOME:-$HOME/.hermes}/plugins/agent-avatar"

# 组装（拷 bridge core 进包目录 + 冒烟自检）五家共用，见 ../assemble.sh
"$here/../assemble.sh" hermes "$target"
echo
echo "接着启用（这一步是显式授权，也是唯一需要的注册动作）："
echo "  hermes plugins enable agent-avatar"
echo
echo "已在跑的 Hermes 会话不会加载新插件，需要重启对应进程。"
