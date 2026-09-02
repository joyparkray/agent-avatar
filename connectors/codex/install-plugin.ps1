# 本文件**必须以 UTF-8 BOM 保存**（理由见 assemble.ps1 顶部）。
<#
.SYNOPSIS
  把 Agent Avatar 装成 Codex 插件（Windows 侧），对应 POSIX 的 install-plugin.sh。

.DESCRIPTION
  为什么是插件而不是直接改 hooks.json：
    - 用户在 app 的 Plugins 标签页里就能开关，不用手改配置文件；
    - hook 命令用 ${PLUGIN_ROOT} 定位，路径不会因为仓库被移动而失效。

  🔴 **Windows 的登记方式和 mac 不一样**（2026-09-02 实测）。
  mac 那条路是「往 `~/.agents/plugins/marketplace.json` 里加一条，再 `codex plugin add`」——
  Windows 上的 ChatGPT app **不读那个文件**，也不带 codex CLI。它的真实登记处是
  `$CODEX_HOME\config.toml`：

      [marketplaces.<名字>]
      source_type = "local"
      source = '<marketplace 根目录的绝对路径>'

      [plugins."<插件>@<名字>"]
      enabled = true

  照 mac 那套装，表现是**装完一切正常、重启 app 后 Plugins 页里根本没有这一项**
  （实测撞到过）—— 又是一次「安静地什么都没发生」。

  所以这里照 app 自带 marketplace（`openai-bundled`）的实物布局造一个自包含的目录：

      <CODEX_HOME>\local-marketplaces\agent-avatar-local\
        .agents\plugins\marketplace.json     ← 清单，plugin 的 path 相对这一层
        plugins\agent-avatar\                ← 组装出来的插件树

  插件树本身的布局照官方已装插件的实际约定（hooks.json 在插件根、plugin.json 不带顶层
  hooks 字段），组装与解释器改写交给 ..\assemble.ps1。hooks.json 里写的是 Codex 自己的
  `commandWindows` 覆盖字段，POSIX 那条 `/usr/bin/python3` 原样留着。

  ⚠️ **杀毒软件可能拦下这个脚本。** 「PowerShell 脚本修改用户目录下另一个应用的配置文件」
  是安装器的正常行为，也正好是行为分析引擎的经典误报形状（实测：卡巴斯基 PDM 判
  `PDM:Trojan.Win32.Generic` 并直接删掉本文件，2026-09-02）。被拦时用 `-PrintOnly`：
  它只打印要加进 config.toml 的那两段，你自己粘贴即可，脚本不碰任何配置文件。

.PARAMETER Target
  插件目录。默认在上面那个自包含 marketplace 的 plugins\agent-avatar 下。

.PARAMETER PrintOnly
  只组装插件树并打印要登记的 TOML，**不改 config.toml**。给被杀软拦住、
  或者想先看清楚再动手的人用。

.NOTES
  卸载：从 config.toml 里删掉那两段，再删掉 marketplace 目录。
#>
param([string]$Target, [switch]$PrintOnly)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$marketName = "agent-avatar-local"
$market = Join-Path $codexHome "local-marketplaces\$marketName"
if (-not $Target) { $Target = Join-Path $market "plugins\agent-avatar" }
$config = Join-Path $codexHome "config.toml"

# 幂等：清掉本插件早期布局留下的 `hooks\` 子目录。留着的话那份 stale hooks.json 会和
# 根目录的新版并存，可能被重复加载或让 validator 困惑。只删我们自己创建过的这一个。
$stale = Join-Path $Target "hooks"
if (Test-Path -LiteralPath $stale -PathType Container) {
  Remove-Item -LiteralPath $stale -Recurse -Force
  Write-Host "removed stale layout: $stale"
}

& (Join-Path $here "..\assemble.ps1") -Harness codex -Target $Target

# ---------------------------------------------------------------------------
# marketplace 清单
# ---------------------------------------------------------------------------

<#
`source.path` 相对 marketplace 根解析，必须以 `./` 开头且留在根之内。
**给绝对路径会被静默丢弃** —— 表现为插件在列表里根本不出现，不报错（mac 实测，2026-08-28）。

PowerShell 5.1 没有 .NET Core 的 Path.GetRelativePath，用 Uri.MakeRelativeUri 代替；
它吐出来的就是正斜杠形式，正好是 marketplace.json 要的形状。
#>
function Get-RelativeTo([string]$root, [string]$path) {
  $rootUri = New-Object System.Uri (($root.TrimEnd("\", "/")) + "\")
  $pathUri = New-Object System.Uri ((Resolve-Path -LiteralPath $path).ProviderPath)
  return [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString())
}

$relative = Get-RelativeTo $market $Target
if ($relative.StartsWith("..")) { throw "插件目录必须在 marketplace 根（$market）之内，当前在 $Target" }

$doc = [pscustomobject]@{
  name      = $marketName
  interface = [pscustomobject]@{ displayName = "Agent Avatar (local)" }
  plugins   = @([pscustomobject]@{
    name     = "agent-avatar"
    source   = [pscustomobject]@{ source = "local"; path = "./$relative" }
    policy   = [pscustomobject]@{ installation = "AVAILABLE" }
    category = "Productivity"
  })
}
$manifestDir = Join-Path $market ".agents\plugins"
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
# 不用 Out-File -Encoding utf8：PowerShell 5.1 会写 BOM，而 JSON 解析器普遍不接受
[System.IO.File]::WriteAllText((Join-Path $manifestDir "marketplace.json"),
  ($doc | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "marketplace -> $market\.agents\plugins\marketplace.json"
Write-Host "  path=./$relative"

# ---------------------------------------------------------------------------
# 往 config.toml 登记
# ---------------------------------------------------------------------------

# `source` 用 TOML 的字面量字符串（单引号）—— 反斜杠在里面不转义，
# app 自己写的那两条也是这么写的。
$marketBlock = @(
  "[marketplaces.$marketName]",
  'source_type = "local"',
  "source = '$market'"
) -join "`n"
$pluginBlock = @(
  "[plugins.`"agent-avatar@$marketName`"]",
  "enabled = true"
) -join "`n"

if ($PrintOnly) {
  Write-Host ""
  Write-Host "插件树已就位，**没有改任何配置文件**。把下面这两段加到文件末尾即可：" -ForegroundColor Yellow
  Write-Host "  $config"
  Write-Host ""
  Write-Host $marketBlock
  Write-Host ""
  Write-Host $pluginBlock
  Write-Host ""
  Write-Host "（已经有同名的两段就整段替换掉，别留两份）"
  exit 0
}

<#
按段落处理，不做 TOML 解析：这是用户的主配置文件，里面有 app 自己写的东西
（模型、notify、mcp_servers…），任何「读出来再整体写回去」的做法都可能丢格式或丢内容。
只做两件事：本插件的两段若已存在就整段替换，不存在就追加。先备份。
#>
$text = if (Test-Path -LiteralPath $config) { [System.IO.File]::ReadAllText($config) } else { "" }
if (Test-Path -LiteralPath $config) {
  Copy-Item -LiteralPath $config -Destination "$config.bak-agent-avatar" -Force   # 用户主配置，先备份
}
# 已有的两段整段删掉（section 头 → 下一个 section 头之前），再统一追加到文件末尾
foreach ($header in @("[marketplaces.$marketName]", "[plugins.`"agent-avatar@$marketName`"]")) {
  $pattern = "(?ms)^" + [regex]::Escape($header) + "\r?\n.*?(?=^\[|\z)"
  $text = [regex]::Replace($text, $pattern, "")
}
$text = $text.TrimEnd() + "`n`n" + $marketBlock + "`n`n" + $pluginBlock + "`n"
[System.IO.File]::WriteAllText($config, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "config.toml -> 已登记 marketplaces.$marketName 与 plugins.`"agent-avatar@$marketName`""
Write-Host "  （原文件备份在 $config.bak-agent-avatar）"
Write-Host "files -> $Target"

Write-Host ""
Write-Host "接着："
Write-Host "  1) **完全退出 ChatGPT app 再打开**（插件在启动时被发现；"
Write-Host "     而且 app 运行时也会写 config.toml，装的时候最好是关着的）"
Write-Host "  2) 在 Plugins 标签页里确认 Agent Avatar 已启用"
Write-Host "  3) **这一步要你自己点**：在 Codex 会话里 /hooks 审阅并信任它的 hooks。"
Write-Host "     启用插件不会自动信任 hooks，Codex 会一直跳过未信任的 hook。"
Write-Host "     这是安全设计，不是故障 —— 也正因为如此，不该由别人代点。"
