# 本文件**必须以 UTF-8 BOM 保存**（理由见 assemble.ps1 顶部）。
<#
.SYNOPSIS
  把 Agent Avatar 的 Hermes 插件装进 $HERMES_HOME\plugins\agent-avatar（Windows 侧）。

.DESCRIPTION
  只往插件目录里写三个文件，**不碰用户的 config.yaml**。

  Hermes 是五家里唯一在 Windows 上**原样可用**的一家：它的插件是 in-process 的
  Python 包，跑在 Hermes 自己的解释器里，不 spawn 任何子进程 ——
  于是「python3 在 Windows 上是应用商店存根」那颗雷根本碰不到它。
  也正因为如此，它可以当 Windows 接线的**基线**：这家不动，其它四家才好定位问题。

.NOTES
  卸载：hermes plugins disable agent-avatar，然后删掉插件目录。
#>
param([string]$Target)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 🔴 Windows 上 Hermes 的 home 是 %LOCALAPPDATA%\hermes，**不是** ~/.hermes
# （官方安装器放在那儿，而且不设 HERMES_HOME）。照 POSIX 那套装会装到一个
# Hermes 根本不看的目录里 —— 表现是「装完了、启用不了、也没有任何报错」。
$hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME }
              elseif (Test-Path (Join-Path $env:LOCALAPPDATA "hermes")) { Join-Path $env:LOCALAPPDATA "hermes" }
              else { Join-Path $env:USERPROFILE ".hermes" }
if (-not $Target) { $Target = Join-Path $hermesHome "plugins\agent-avatar" }

& (Join-Path $here "..\assemble.ps1") -Harness hermes -Target $Target

Write-Host ""
Write-Host "接着启用（这一步是显式授权，也是唯一需要的注册动作）："
Write-Host "  hermes plugins enable agent-avatar"
Write-Host ""
Write-Host "已在跑的 Hermes 会话不会加载新插件，需要重启对应进程。"
