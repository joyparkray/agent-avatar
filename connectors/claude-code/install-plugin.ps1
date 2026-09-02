# 本文件**必须以 UTF-8 BOM 保存**（理由见 assemble.ps1 顶部）。
<#
.SYNOPSIS
  把 Agent Avatar 装成 Claude Code 插件（Windows 侧），对应 POSIX 的 install-plugin.sh。

.DESCRIPTION
  为什么是插件而不是直接改 settings.json：
    - 用户用 `/plugin` 就能开关，不用手改自己的 settings；
    - hook 命令用 ${CLAUDE_PLUGIN_ROOT} 定位，路径不会因为仓库被移动而失效；
    - 与 Hermes / Codex 的接入方式一致，用户只需要理解一个概念。

  🔴 **光把文件拷进 ~/.claude 是不会被发现的**（2026-09-02 实测）。Claude Code 只认
  「已登记的 marketplace 里已安装的插件」，所以这里造一个自包含的本地 marketplace：

      <CLAUDE_CONFIG_DIR>\local-marketplaces\agent-avatar-local\
        .claude-plugin\marketplace.json     ← 清单，plugin 的 source 相对这一层
        plugins\agent-avatar\               ← 组装出来的插件树

  再用 CLI 登记 + 安装。和 Codex / WorkBuddy 的形状一致（三家都是「本地 marketplace」）。

  ⚠️ **安装会把插件树整个拷进 `plugins\cache\<market>\<plugin>\<版本>\`**，而版本号没变时
  `plugin install` 只会说「已安装」、**不刷新那份拷贝**。所以重装时先 uninstall 再 install，
  否则改完脚本重跑一遍，跑的还是旧副本 —— 又一个「装了、看着正常、就是没生效」。

  组装到插件目录而不是直接用仓库目录：插件必须**自包含**（hook 入口 + bridge core），
  而状态机的单一真相在 ../../bridge/。组装交给 ..\assemble.ps1，它同时把 hooks.json 里的
  `python3` 换成本机实测可用的解释器绝对路径 —— Windows 上 `python3` 是 0 字节的
  应用商店存根，不换就是静默失效。

.PARAMETER Target
  插件目录。默认在上面那个自包含 marketplace 的 plugins\agent-avatar 下。
  想先验一遍再装的话，直接用 `..\assemble.ps1 -Harness claude-code -Target <临时目录>`
  组装到临时目录，再 `claude --plugin-dir <临时目录>` —— 那样不碰你现在的配置。

.NOTES
  卸载：claude plugin uninstall agent-avatar
        claude plugin marketplace remove agent-avatar-local
#>
param([string]$Target)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# $HOME 在 PowerShell 里不一定是 Windows 的用户目录（会被 profile 改写），所以直接用 USERPROFILE
$configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude" }
$marketName = "agent-avatar-local"
$market = Join-Path $configDir "local-marketplaces\$marketName"
if (-not $Target) { $Target = Join-Path $market "plugins\agent-avatar" }

& (Join-Path $here "..\assemble.ps1") -Harness claude-code -Target $Target

# ---------------------------------------------------------------------------
# 本地 marketplace 清单
# ---------------------------------------------------------------------------

# `source` 是相对 marketplace 根的路径（官方 marketplace 里的第三方插件用的是 git-subdir，
# 本地目录用相对路径这一种形式）。必须以 `./` 开头且留在根之内。
$manifest = @'
{
  "name": "agent-avatar-local",
  "description": "Agent Avatar —— AI agent 的桌面形象层（本地 marketplace）",
  "owner": { "name": "Agent Avatar" },
  "plugins": [
    {
      "name": "agent-avatar",
      "description": "把 Claude Code 的会话/工具/子代理事件聚合成语义状态，供 Agent Avatar 桌面形象读取。纯观察者，不改变 Claude Code 的行为。",
      "source": "./plugins/agent-avatar",
      "category": "productivity"
    }
  ]
}
'@
$manifestDir = Join-Path $market ".claude-plugin"
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
# 不用 Out-File -Encoding utf8：PowerShell 5.1 会写 BOM，而 JSON 解析器普遍不接受
[System.IO.File]::WriteAllText((Join-Path $manifestDir "marketplace.json"), $manifest,
  (New-Object System.Text.UTF8Encoding($false)))
Write-Host "marketplace -> $manifestDir\marketplace.json"

# ---------------------------------------------------------------------------
# 登记 + 安装
# ---------------------------------------------------------------------------

$cli = Get-Command claude -ErrorAction SilentlyContinue
if (-not $cli) {
  Write-Host ""
  Write-Host "PATH 里没有 claude CLI，跳过登记与安装。装好 CLI 后手动跑这两条：" -ForegroundColor Yellow
  Write-Host "  claude plugin marketplace add $market"
  Write-Host "  claude plugin install agent-avatar@$marketName"
  exit 0
}

& claude plugin marketplace add $market
if ($LASTEXITCODE -ne 0) { throw "claude plugin marketplace add 失败：$market" }

# 已装过就先卸掉：install 对已安装的名字只会说「已安装」，**不会刷新缓存里那份拷贝**
$listed = (& claude plugin list 2>$null | Out-String)
if ($listed -match "agent-avatar@$marketName") {
  Write-Host "已安装过，先卸载以刷新缓存里的副本…"
  & claude plugin uninstall agent-avatar | Out-Null
}
& claude plugin install "agent-avatar@$marketName"
if ($LASTEXITCODE -ne 0) { throw "claude plugin install 失败" }

Write-Host ""
Write-Host "装好了。**已经在跑的会话不会自动加载**：新开一个会话，或在会话里 /reload-plugins。"
Write-Host "验证：「claude plugin list」应当显示 enabled；随便让它跑一条命令，"
Write-Host "      %TEMP%\agent-avatar-state.claude-code.json 的 state 应当跟着变。"
Write-Host ""
Write-Host "如果你以前手工在 settings.json 里注册过 agent-avatar-hook，请删掉那条 ——" -ForegroundColor Yellow
Write-Host "  否则两条链路会对同一个状态文件重复记账。" -ForegroundColor Yellow
