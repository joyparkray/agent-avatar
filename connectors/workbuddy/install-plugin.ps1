# 本文件**必须以 UTF-8 BOM 保存**（理由见 assemble.ps1 顶部）。
<#
.SYNOPSIS
  把 Agent Avatar 装成 WorkBuddy 插件（Windows 侧），对应 POSIX 的 install-plugin.sh。

.DESCRIPTION
  WorkBuddy 的 agent core 是 **CodeBuddy Code CLI**，插件与 hook 机制与 Claude Code 同形。
  装法是官方的「本地 marketplace」：造一个含 `.codebuddy-plugin\marketplace.json` 的目录，
  `plugin marketplace add` 登记，再 `plugin install`。

  Windows 上 CLI 有两个来源：app 自带的那一份，和
  `npm install -g @tencent-ai/codebuddy-code` 装出来的 `codebuddy`。
  这里按 CODEBUDDY_CLI → PATH 的顺序找，找不到就明确报错停下 ——
  不要在没有 CLI 的机器上留下一个「登记了但没人装」的半成品。

.PARAMETER Target
  插件源码目录（本地 marketplace 里的那份）。默认在 $WORKBUDDY_HOME\local-marketplaces\ 下。

.NOTES
  卸载：codebuddy plugin uninstall agent-avatar
        codebuddy plugin marketplace remove agent-avatar-local
#>
param([string]$Target)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$wbHome = if ($env:WORKBUDDY_HOME) { $env:WORKBUDDY_HOME } else { Join-Path $env:USERPROFILE ".workbuddy" }
# 🔴 **必须装进 app 的配置目录**。同一个 CLI 有两个 home：
#   - 独立跑 CLI 时默认 %USERPROFILE%\.codebuddy
#   - WorkBuddy app 用 %USERPROFILE%\.workbuddy（app 侧 WORKBUDDY_CONFIG_DIR，CLI 侧 CODEBUDDY_CONFIG_DIR）
# 不设这个变量，`plugin install` 会把插件登记到 .codebuddy —— 表现是**命令行验证一切正常、
# app 里新会话完全没反应**（mac 实机撞到过，2026-08-28）。
$configDir = if ($env:CODEBUDDY_CONFIG_DIR) { $env:CODEBUDDY_CONFIG_DIR } else { $wbHome }
$env:CODEBUDDY_CONFIG_DIR = $configDir
$market = Join-Path $wbHome "local-marketplaces\agent-avatar-local"
if (-not $Target) { $Target = Join-Path $market "plugins\agent-avatar" }

$cli = $env:CODEBUDDY_CLI
if (-not $cli) {
  $found = Get-Command codebuddy -ErrorAction SilentlyContinue
  if ($found) { $cli = $found.Source }
}
if (-not $cli -or -not (Test-Path -LiteralPath $cli)) {
  Write-Host ""
  Write-Host "找不到 codebuddy CLI。" -ForegroundColor Red
  Write-Host ""
  Write-Host "  方式一 自己跑一条命令："
  Write-Host "    npm install -g @tencent-ai/codebuddy-code"
  Write-Host ""
  Write-Host "  或者指到 app 自带的那一份再跑一次（PowerShell）："
  Write-Host "    `$env:CODEBUDDY_CLI = 'C:\path\to\codebuddy.cmd'"
  Write-Host ""
  exit 1
}

& (Join-Path $here "..\assemble.ps1") -Harness workbuddy -Target $Target

$manifest = @'
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
'@
$manifestDir = Join-Path $market ".codebuddy-plugin"
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
# 不用 Out-File -Encoding utf8：PowerShell 5.1 会写 BOM，而 JSON 解析器普遍不接受
[System.IO.File]::WriteAllText((Join-Path $manifestDir "marketplace.json"), $manifest, (New-Object System.Text.UTF8Encoding($false)))

# 官方校验器：清单写错时这里就会拦下，不必等到装完发现没反应
& $cli plugin validate $market | Out-Null
if ($LASTEXITCODE -ne 0) { throw "codebuddy plugin validate 没过：$market" }

# 幂等：已登记过就更新，没有就添加（add 对已存在的名字会报错）
$listed = (& $cli plugin marketplace list 2>$null | Out-String)
if ($listed -match "agent-avatar-local") {
  & $cli plugin marketplace update agent-avatar-local | Out-Null
} else {
  & $cli plugin marketplace add $market | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "codebuddy plugin marketplace add 失败：$market" }
}
& $cli plugin install agent-avatar@agent-avatar-local
if ($LASTEXITCODE -ne 0) { throw "codebuddy plugin install 失败" }

Write-Host ""
Write-Host "登记在：$configDir （app 读这里；独立 CLI 默认读 %USERPROFILE%\.codebuddy，"
Write-Host "         要给独立 CLI 也装一份，就把 CODEBUDDY_CONFIG_DIR 指过去再跑一次）"
Write-Host ""
Write-Host "装好了。WorkBuddy app 需要**重启**才会加载新插件（CLI 下次运行即生效）。"
Write-Host "验证：随便发一句让它跑 sleep 4 的话，形象应当走 writing → executing → writing → idle。"
