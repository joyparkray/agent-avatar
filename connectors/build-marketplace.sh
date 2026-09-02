#!/bin/sh
# 造出**可以直接被各家 harness clone 的那棵树** —— 也就是 connector 的发布物。
#
# 为什么是一棵树而不是一个 zip：定案（见 private/RELEASE-CONNECTOR-WIZARD-DESIGN.md
# 「已定方案」）之后，connector 不再由 app 下载 zip、也不再由 app 跑安装脚本。
# 分发走各家自己的插件渠道 —— 用户（或他的 agent）执行一条钉死的命令，
# harness 自己去 clone 这棵树。少了「下载 + 解压 + 执行脚本」三步，也就少了
# Mark of the Web 与「未签名脚本改配置」这两个杀软误报的来源（实机被卡巴删过文件）。
#
# 🔴 **这棵树必须机器无关。** 里面的 hooks.json 写的是 `python3`，不是某台机器上的
# 解释器绝对路径 —— 那是**安装时**由 agent 在用户机器上做的事（只有 Windows 需要）。
# 所以别在这里调 assemble.ps1，它会把本机路径烤进去。
#
# 一个仓库同时当三家的 marketplace：三家的清单文件名互不相同，实测互不干扰
# （2026-09-02：同一个目录 `claude plugin marketplace add` 与 `codebuddy plugin
# marketplace add` 都成功装出插件）。
#
#   <out>/.claude-plugin/marketplace.json      Claude Code 读这份
#   <out>/.agents/plugins/marketplace.json     Codex 读这份
#   <out>/.codebuddy-plugin/marketplace.json   WorkBuddy 读这份
#   <out>/plugins/<harness>/agent-avatar/      五家各自的插件树
#
# 五家的插件树布局各不相同（清单目录名、hooks.json 的位置、脚本目录名都不一样），
# 所以每家一棵，不共用。全部加起来不到 100 KB。
#
# 用法：build-marketplace.sh [outdir]        默认 ../release/marketplace
# 解释器：AGENT_AVATAR_PYTHON 可指定（见 assemble.sh 顶部）
set -eu

# 发布仓库。**前端的 MARKETPLACE_REPO 必须与这里一致**（有测试盯着）——
# 两处各写一份必然会漂，而漂了之后表现是「照提示词跑完，装的是另一个仓库」。
REPO=joyparkray/agent-avatar-connectors

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=${1:-$here/../release/marketplace}
mkdir -p "$out"
out=$(CDPATH= cd -- "$out" && pwd)

# 版本取自 Claude Code 那份 plugin.json —— 五家本来就该同版本发布，
# 这里顺带把「五家版本是否一致」变成一条会失败的检查。
version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
          "$here/claude-code/plugin/agent-avatar/.claude-plugin/plugin.json" | head -1)
[ -n "$version" ] || { echo "读不到版本号" >&2; exit 1; }
for manifest in "$here/codex/plugin/agent-avatar/.codex-plugin/plugin.json" \
                "$here/workbuddy/plugin/agent-avatar/.codebuddy-plugin/plugin.json"; do
  other=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -1)
  [ "$other" = "$version" ] || { echo "版本不一致：$manifest 是 $other，应为 $version" >&2; exit 1; }
done

# 每家组装进 plugins/<harness>/agent-avatar。assemble.sh 顺带跑冒烟自检 ——
# 漏拷 core 的失败在真实注册里是静默的（hook 被跳过 / 形象一直 idle）。
for harness in hermes claude-code codex dsh workbuddy; do
  rm -rf "$out/plugins/$harness"
  "$here/assemble.sh" "$harness" "$out/plugins/$harness/agent-avatar"
done

# Windows 上装 connector 时那一步「本地化」。放进发布树里，是为了让提示词能退化成
# **一条钉死的命令**（`python localize.py <harness>`），而不是让 agent 逐字去改 JSON ——
# 后者每次结果都可能不同，而这条链路上的错误是静默的。
cp "$here/localize.py" "$out/localize.py"

# ---------------------------------------------------------------------------
# 三份清单
# ---------------------------------------------------------------------------

description='把 agent 的会话/工具/子代理事件聚合成语义状态，供 Agent Avatar 桌面形象读取。纯观察者：不改变 agent 的行为，不参与权限决策。'

# Claude Code：`source` 是相对 marketplace 根的路径。
# **不写 version** —— 官方：清单与 plugin.json 都写时以 plugin.json 为准且不告警，
# 两处都写只会让某天不一致时无声地用错一个。
mkdir -p "$out/.claude-plugin"
cat > "$out/.claude-plugin/marketplace.json" <<JSON
{
  "name": "agent-avatar",
  "description": "Agent Avatar connectors — 让桌面形象跟着你的 agent 变表情",
  "owner": { "name": "Agent Avatar", "url": "https://github.com/joyparkray/agent-avatar" },
  "plugins": [
    {
      "name": "agent-avatar",
      "description": "$description",
      "source": "./plugins/claude-code/agent-avatar",
      "category": "productivity",
      "homepage": "https://github.com/joyparkray/agent-avatar"
    }
  ]
}
JSON

# Codex：清单在 `.agents/plugins/`，`source` 是个对象，路径必须以 `./` 开头。
# **给绝对路径会被静默丢弃**（插件在列表里根本不出现，不报错 —— mac 实测撞到过）。
mkdir -p "$out/.agents/plugins"
cat > "$out/.agents/plugins/marketplace.json" <<JSON
{
  "name": "agent-avatar",
  "interface": { "displayName": "Agent Avatar" },
  "plugins": [
    {
      "name": "agent-avatar",
      "source": { "source": "local", "path": "./plugins/codex/agent-avatar" },
      "policy": { "installation": "AVAILABLE" },
      "category": "Productivity"
    }
  ]
}
JSON

# WorkBuddy：与 Claude Code 同形，清单目录是 `.codebuddy-plugin/`。
mkdir -p "$out/.codebuddy-plugin"
cat > "$out/.codebuddy-plugin/marketplace.json" <<JSON
{
  "name": "agent-avatar",
  "description": "Agent Avatar connectors — 让桌面形象跟着你的 agent 变表情",
  "owner": { "name": "Agent Avatar" },
  "metadata": { "version": "$version" },
  "plugins": [
    {
      "name": "agent-avatar",
      "description": "$description",
      "source": "./plugins/workbuddy/agent-avatar",
      "version": "$version",
      "category": "productivity",
      "author": { "name": "Agent Avatar" },
      "license": "MIT"
    }
  ]
}
JSON

# ---------------------------------------------------------------------------
# 自检：三份清单必须是合法 JSON，且指到的目录必须真的在
# ---------------------------------------------------------------------------
"${AGENT_AVATAR_PYTHON:-python3}" - "$out" <<'PY'
import json, os, sys
root = sys.argv[1]
manifests = {
    "claude-code": ".claude-plugin/marketplace.json",
    "codex": ".agents/plugins/marketplace.json",
    "workbuddy": ".codebuddy-plugin/marketplace.json",
}
for harness, relative in manifests.items():
    path = os.path.join(root, relative)
    with open(path, encoding="utf-8") as handle:
        doc = json.load(handle)          # 清单坏掉时 harness 只会「不显示这一项」，不报错
    entry = doc["plugins"][0]
    source = entry["source"]
    target = source if isinstance(source, str) else source["path"]
    assert target.startswith("./"), "%s: 路径必须以 ./ 开头，绝对路径会被静默丢弃" % relative
    assert os.path.isdir(os.path.join(root, target)), "%s 指到的目录不存在：%s" % (relative, target)
    print("  %-12s -> %s" % (harness, target))
# 五家的插件树都要在（dsh 与 hermes 不走 marketplace，但也从这棵树里取）
for harness in ("claude-code", "codex", "workbuddy", "dsh", "hermes"):
    assert os.path.isdir(os.path.join(root, "plugins", harness, "agent-avatar")), harness
PY

cat > "$out/README.md" <<MD
# Agent Avatar connectors

让桌面形象跟着你的 agent 变表情。这个仓库就是五家 harness 的插件本体 ——
**它同时是三家的 plugin marketplace**（三份清单文件名互不相同，互不干扰）。

版本：$version

## 装法

装 connector 这件事交给你的 agent 做 —— 你本来就坐在一个能执行命令的 agent 面前。
把对应的那段贴给它即可。命令都是钉死的，你可以先读一遍再让它跑。

### Claude Code

\`\`\`
claude plugin marketplace add $REPO
claude plugin install agent-avatar@agent-avatar
\`\`\`

**Windows 上多一步**：\`python3\` 在 Windows 不是 Python（是 0 字节的应用商店存根），
所以要先把插件树本地化到这台机器：

\`\`\`
git clone https://github.com/$REPO agent-avatar-connectors
cd agent-avatar-connectors
python localize.py claude-code
claude plugin marketplace add .
claude plugin install agent-avatar@agent-avatar
\`\`\`

### WorkBuddy（CodeBuddy Code）

把上面的 \`claude\` 换成 \`codebuddy\`，\`localize.py\` 的参数换成 \`workbuddy\`。

### Codex

\`\`\`
codex plugin marketplace add $REPO
codex plugin install agent-avatar@agent-avatar
\`\`\`

装好后**必须你自己**在 Codex 会话里跑 \`/hooks\` 逐条授信 ——
启用插件不会自动信任它的 hook，未授信的 hook 会被一直跳过。这是安全设计，不是故障。

### DeepSeek Harness (dsh) / Hermes

见各自 \`plugins/<harness>/agent-avatar/\` 下的说明。

## 这里面是什么

- \`plugins/<harness>/agent-avatar/\` —— 五家各自的插件树（纯观察者：只读事件、
  写一个本地状态文件，从不返回指令、不拦工具、不参与审批）
- \`localize.py\` —— Windows 上把解释器换成本机绝对路径的那一步，跑完会自检到
  「状态文件真的落盘」为止
- 三份 marketplace 清单

## 怎么确认它真的通了

不要看「有没有报错」—— hook 的设计是**永远 exit 0**（退出码 2 会 block 住 agent），
所以退出码说明不了任何事。要看**状态文件**：

- Windows: \`%TEMP%\agent-avatar-state.<harness>.json\`
- macOS / Linux: \`\$TMPDIR/agent-avatar-state.<harness>.json\`

内容应当随会话变化（idle / writing / executing / awaiting）。
MD

echo "marketplace v$version -> $out"
