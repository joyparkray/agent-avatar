#!/bin/sh
# 把 Agent Avatar 装成 WorkBuddy 插件。
#
# WorkBuddy 的 agent core 是随 app 分发的 **CodeBuddy Code CLI**（实机 v2.115.0），
# 插件与 hook 机制与 Claude Code 同形。装法是官方的「本地 marketplace」：
# 造一个含 `.codebuddy-plugin/marketplace.json` 的目录，`plugin marketplace add` 登记，
# 再 `plugin install`。这与它自带的三个 marketplace 是同一条路径。
#
# 卸载：codebuddy plugin uninstall agent-avatar
#       codebuddy plugin marketplace remove agent-avatar-local
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
wb_home="${WORKBUDDY_HOME:-$HOME/.workbuddy}"
# 🔴 **必须装进 app 的配置目录**。同一个 CLI 有两个 home：
#   - 独立跑 CLI 时默认 `~/.codebuddy`
#   - WorkBuddy app 用 `~/.workbuddy`（app 侧 WORKBUDDY_CONFIG_DIR，CLI 侧 CODEBUDDY_CONFIG_DIR）
# 不设这个变量，`plugin install` 会把插件登记到 `~/.codebuddy` —— 表现是**命令行验证一切正常、
# app 里新会话完全没反应**（实机撞到过，2026-08-28）。
config_dir="${CODEBUDDY_CONFIG_DIR:-$wb_home}"
export CODEBUDDY_CONFIG_DIR="$config_dir"
market="$wb_home/local-marketplaces/agent-avatar-local"
# CLI 在 app 包里；允许用环境变量指到别处（多版本 / 非默认安装路径）
cli="${CODEBUDDY_CLI:-/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy}"

[ -x "$cli" ] || { echo "找不到 WorkBuddy 自带的 codebuddy CLI：$cli
（换路径请设 CODEBUDDY_CLI=/path/to/codebuddy 再跑）" >&2; exit 1; }

# 组装（拷 core 进插件目录 + 冒烟自检）五家共用，见 ../assemble.sh
"$here/../assemble.sh" workbuddy "$market/plugins/agent-avatar"

mkdir -p "$market/.codebuddy-plugin"
cat > "$market/.codebuddy-plugin/marketplace.json" <<'JSON'
{
  "name": "agent-avatar-local",
  "description": "Agent Avatar —— AI agent 的桌面形象层（本地 marketplace）",
  "owner": { "name": "Agent Avatar" },
  "metadata": { "version": "1.0.0" },
  "plugins": [
    {
      "name": "agent-avatar",
      "description": "把 WorkBuddy 的会话/工具/子代理事件聚合成语义状态，供 Agent Avatar 桌面形象读取。纯观察者，不改变 WorkBuddy 的行为。",
      "source": "./plugins/agent-avatar",
      "version": "1.0.0",
      "category": "productivity",
      "author": { "name": "Agent Avatar" },
      "license": "MIT"
    }
  ]
}
JSON

# 官方校验器：清单写错时这里就会拦下，不必等到装完发现没反应
"$cli" plugin validate "$market" >/dev/null

# 幂等：已登记过就更新，没有就添加（add 对已存在的名字会报错）
if "$cli" plugin marketplace list 2>/dev/null | grep -q "agent-avatar-local"; then
  "$cli" plugin marketplace update agent-avatar-local >/dev/null || true
else
  "$cli" plugin marketplace add "$market" >/dev/null
fi
"$cli" plugin install agent-avatar@agent-avatar-local

echo
echo "登记在：$config_dir （app 读这里；独立 CLI 默认读 ~/.codebuddy，"
echo "         要给独立 CLI 也装一份，就 CODEBUDDY_CONFIG_DIR=~/.codebuddy 再跑一次）"
echo
echo "装好了。WorkBuddy app 需要**重启**才会加载新插件（CLI 下次运行即生效）。"
echo "验证：随便发一句让它跑 \`sleep 4\` 的话，形象应当走 writing → executing → writing → idle。"
