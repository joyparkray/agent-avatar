# 本文件**必须以 UTF-8 BOM 保存**（理由见 assemble.ps1 顶部）。
<#
.SYNOPSIS
  把 Agent Avatar 装进 DeepSeek Harness（Windows 侧），对应 POSIX 的 install-plugin.sh。

.DESCRIPTION
  dsh 没有「插件市场」式的安装命令给本地目录用，装法是**用户 patch 层**：
  `$DSH_HOME\cordis.patch.yml`（home 级，对所有 profile 生效，且排在每个 profile 的
  patch 之后）里 insert 一条指向插件目录的 entry。这个文件被 dsh 的 HMR 监视着
  （`watchUserPatches`）—— 已经在跑的 dsh 会**热加载**，不需要重启。

  装法本身与平台无关；Windows 上真正要改的是**插件里那次 spawn**：
  index.mjs 原来 spawn 的是 `python3`，而 Windows 上那个名字解析到一个 0 字节的
  应用商店存根。更糟的是这条链路的 stderr 被 `ignore`、`error` 事件又只在 spawn 失败时
  触发，而存根**是能成功启动的** —— 五家里最静默的一种坏法。
  所以 ..\assemble.ps1 会把解释器绝对路径写进 index.mjs（`AGENT_AVATAR_PYTHON` 仍然优先）。

.NOTES
  卸载：从 $DSH_HOME\cordis.patch.yml 里删掉 agent-avatar 那一段，再删掉插件目录。
#>
param([string]$Target)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
if (-not $Target) { $Target = Join-Path $dshHome "plugins\agent-avatar" }
$patch = Join-Path $dshHome "cordis.patch.yml"

& (Join-Path $here "..\assemble.ps1") -Harness dsh -Target $Target

<#
YAML 只写不读：dsh 的 patch 文件允许 `!!js` 表达式，用普通 YAML 解析器读会**丢掉**
用户已有的那些行（甚至报错）。所以按行处理 —— 只认自己那一段，其余原样保留。

🔴 **entry 的 name 在 Windows 上必须写成 `file:///` URL**，不能是 `C:/...`。
dsh 把这个字符串当 ESM specifier 直接 import()，而 Node 会把 `C:/...` 解析成
scheme 为 `c:` 的 URL —— 报 ERR_UNSUPPORTED_ESM_URL_SCHEME（实测，2026-09-02）。
POSIX 上 `/home/...` 恰好不会踩到，所以 sh 版写的是裸路径。
file URL 里的路径本来就是正斜杠，顺带也避开了 YAML 里的反斜杠歧义。
#>
$begin = "# >>> agent-avatar (managed) >>>"
$end   = "# <<< agent-avatar (managed) <<<"
$entryPath = ([uri](Resolve-Path -LiteralPath (Join-Path $Target "index.mjs")).ProviderPath).AbsoluteUri
$block = @($begin, "- insert:", "    - id: agent-avatar", "      name: $entryPath", $end)

New-Item -ItemType Directory -Force -Path $dshHome | Out-Null
$kept = @()
if (Test-Path -LiteralPath $patch) {
  Copy-Item -LiteralPath $patch -Destination "$patch.bak-agent-avatar" -Force   # 用户文件，先备份
  $skipping = $false
  foreach ($line in [System.IO.File]::ReadAllLines($patch)) {   # 按 UTF-8 读，别让 ANSI 解码毁掉非 ASCII 行
    if ($line.Trim() -eq $begin) { $skipping = $true; continue }
    if ($line.Trim() -eq $end)   { $skipping = $false; continue }
    # 模板文件里的 `[]` 是「空数组」。留着它，后面再跟条目就成了非法 YAML。
    if (-not $skipping -and $line.Trim() -ne "[]") { $kept += $line }
  }
}
$body = ($kept -join "`n").TrimEnd()
$text = $(if ($body) { $body + "`n" } else { "" }) + ($block -join "`n") + "`n"
[System.IO.File]::WriteAllText($patch, $text, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "patched -> $patch"
Write-Host "files -> $Target"
Write-Host ""
Write-Host "dsh 的 HMR 监视着这个 patch 文件 —— 正在跑的 dsh 会自动加载，不用重启。"
Write-Host "新开一个会话就能看到形象跟着动；没反应时先看 $patch 里那一段还在不在。"
