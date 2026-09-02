# 本文件**必须以 UTF-8 BOM 保存**。PowerShell 5.1（Windows 自带的那个）
# 读没有 BOM 的 .ps1 时按系统 ANSI 代码页解码，中文注释会变成乱码并直接语法报错。
# 改这个文件时注意别把 BOM 弄丢了。
<#
.SYNOPSIS
  组装一家 harness 的插件目录（Windows 侧），对应 POSIX 的 assemble.sh。

.DESCRIPTION
  与 assemble.sh 做同一件事：把 hook 入口 + bridge core 拷进插件目录，然后冒烟自检。
  多做的是 Windows 特有的一步 —— **把 hooks.json 里的解释器换成本机实测可用的绝对路径**。

  为什么必须换：`python3` 在 Windows 上不是 Python。它解析到
  `%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe`，一个 0 字节的应用商店存根，
  运行只会打印「Python was not found」并以 9009 退出。装了 python.org 的机器也一样 ——
  官方安装包只产出 `python.exe` 和 `pythonw.exe`，**从不产出 python3.exe**。

  写进去的那一行有严格的形状要求，见 Set-HookCommand 的注释。

  **故意没有 assemble.sh 那个 `all` 模式。** `all` 是发布路径，而这里写进树里的是
  **本机**的解释器绝对路径 —— 拿它打包分发，用户装到的就是「指向别人机器上某个
  python.exe」的插件，正好是本轮要消灭的那种静默失效。发布树保持机器无关
  （由 assemble.sh 产出，里面仍写着 `python3`），Windows 的改写发生在**安装时**，
  也就是用户在自己机器上跑 install-plugin.ps1 的那一刻。
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("claude-code", "codex", "workbuddy", "dsh", "hermes")]
  [string]$Harness,
  [Parameter(Mandatory = $true)][string]$Target
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridge = Join-Path (Split-Path -Parent $here) "bridge"

# ---------------------------------------------------------------------------
# 解释器检测
# ---------------------------------------------------------------------------

<#
找一个**真的能跑**的 Python，返回它自报的绝对路径。

不能用 `Get-Command python3` 判断有无 —— 商店存根**是存在的**，只是跑不起来。
所以这里让候选自报 `sys.executable`：这一步同时完成「找到」和「筛掉存根」，
而且拿到的就是要写进 hooks.json 的那个绝对路径，不用我们自己去猜安装位置。

候选顺序：`py -3`（官方启动器，装了 python.org 就有）→ `python` → `python3`。
#>
function Resolve-Python {
  foreach ($candidate in @(@("py", "-3"), @("python"), @("python3"))) {
    $exe = $candidate[0]
    $prefix = @($candidate | Select-Object -Skip 1)
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    try {
      $out = & $exe @prefix -c "import sys; print(sys.executable)" 2>$null
    } catch { continue }
    if ($LASTEXITCODE -ne 0) { continue }
    $path = ($out | Select-Object -First 1)
    if ($path) { $path = $path.ToString().Trim() }
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  return $null
}

<#
把解释器路径变成 hooks.json 能用的形状。

**正斜杠**：Windows API 两种分隔符都收，但 Claude Code 在 Windows 上默认用 Git Bash，
而 bash 会把反斜杠当转义吃掉（实测 `C:\Python314\python.exe` → `C:Python314python.exe`）。

**路径不能带空格**：命令行里解释器那一段不能加引号（PowerShell 只在**首个 token**
带引号时把它当字符串表达式，直接报错），所以带空格的路径没法表达。
「为所有用户安装」的默认位置 `C:\Program Files\PythonXXX\` 正好带空格 ——
这时改用 8.3 短路径（`C:/PROGRA~1/...`），它没有空格且两种 shell 都认。
#>
function ConvertTo-HookPath([string]$path) {
  if ($path -match " ") {
    $short = (New-Object -ComObject Scripting.FileSystemObject).GetFile($path).ShortPath
    if ($short -and $short -notmatch " ") { $path = $short }
  }
  return ($path -replace "\\", "/")
}

# ---------------------------------------------------------------------------
# 组装
# ---------------------------------------------------------------------------

function Copy-Into([string]$dir, [string[]]$files) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($file in $files) { Copy-Item -LiteralPath $file -Destination $dir -Force }
}

function Assemble-ClaudeCode([string]$target) {
  $src = Join-Path $here "claude-code"
  Copy-Into (Join-Path $target ".claude-plugin") @((Join-Path $src "plugin/agent-avatar/.claude-plugin/plugin.json"))
  Copy-Into (Join-Path $target "hooks") @(
    (Join-Path $src "plugin/agent-avatar/hooks/hooks.json"),
    (Join-Path $src "agent-avatar-hook.py"),
    (Join-Path $bridge "state_machine.py"),
    (Join-Path $bridge "pascal_events.py"))
}

function Assemble-Codex([string]$target) {
  $src = Join-Path $here "codex"
  Copy-Into (Join-Path $target ".codex-plugin") @((Join-Path $src "plugin/agent-avatar/.codex-plugin/plugin.json"))
  Copy-Into $target @((Join-Path $src "plugin/agent-avatar/hooks.json"))
  Copy-Into (Join-Path $target "scripts") @(
    (Join-Path $src "agent-avatar-hook.py"),
    (Join-Path $bridge "state_machine.py"),
    (Join-Path $bridge "pascal_events.py"))
}

# WorkBuddy 的 agent core 是随 app 分发的 CodeBuddy Code CLI，插件布局与 CC 同形，
# 只是清单目录叫 `.codebuddy-plugin/`，hook 里的占位符是 ${CODEBUDDY_PLUGIN_ROOT}。
function Assemble-WorkBuddy([string]$target) {
  $src = Join-Path $here "workbuddy"
  Copy-Into (Join-Path $target ".codebuddy-plugin") @((Join-Path $src "plugin/agent-avatar/.codebuddy-plugin/plugin.json"))
  Copy-Into (Join-Path $target "hooks") @(
    (Join-Path $src "plugin/agent-avatar/hooks/hooks.json"),
    (Join-Path $src "agent-avatar-hook.py"),
    (Join-Path $bridge "state_machine.py"),
    (Join-Path $bridge "pascal_events.py"))
}

# dsh 插件是 in-process 的 cordis（JS）插件：事件翻译在 index.mjs 里，
# 它再把内部词表的 payload 喂给同级的 python 入口 —— 状态机仍然只有一份。
# 事件名就是内部词表，不需要 pascal_events。
function Assemble-Dsh([string]$target) {
  Copy-Into $target @(
    (Join-Path $here "dsh/plugin/agent-avatar/index.mjs"),
    (Join-Path $here "dsh/agent-avatar-hook.py"),
    (Join-Path $bridge "state_machine.py"))
}

# Hermes 插件是 in-process 的 Python 包，`from .state_machine import update` 在包内解析，
# 所以 core 拷在包根。它跑在 Hermes 自己的解释器里、不 spawn 进程，
# 因此**是五家里唯一不需要改解释器的一家**。
function Assemble-Hermes([string]$target) {
  Copy-Into $target @(
    (Join-Path $here "hermes/plugin/agent-avatar/plugin.yaml"),
    (Join-Path $here "hermes/plugin/agent-avatar/__init__.py"),
    (Join-Path $bridge "state_machine.py"))
}

<#
把 hooks.json 里每一条 command 换成本机的解释器。

写进去的形状是逐条实测定下来的（见 private/WINDOWS-PORT.md「4.6」），三个要求缺一不可：

  C:/Python314/python.exe "${CLAUDE_PLUGIN_ROOT}/hooks/agent-avatar-hook.py" ; exit 0
  └─ 正斜杠、不加引号        └─ 参数加引号（两种 shell 都认）      └─ 保险

`; exit 0` **不能省**：脚本路径万一失效，`python x.py` 的退出码**正好是 2**，
而 2 在 Claude Code 和 Codex 里都是 block —— PreToolUse 拦工具、Stop 让对话停不下来。
`;` 在 bash 和 PowerShell 里都是语句分隔符（只有 cmd.exe 不是，而两家都不用 cmd）。

Codex 走 `commandWindows`（它自己的 Windows 专用覆盖字段），POSIX 那条原样留着；
Claude Code 没有等价字段，直接改 `command`（这份是装到用户目录里的副本，不是仓库文件）。
#>
function Set-HookCommand([string]$file, [string]$python, [string]$harness) {
  # 不用 Get-Content -Raw：PowerShell 5.1 没有 BOM 时按系统 ANSI 代码页解码，
  # 中文注释会变成乱码、多字节字符还会吃掉后面的换行。ReadAllText 默认按 UTF-8 读。
  $text = [System.IO.File]::ReadAllText($file)
  $json = $text | ConvertFrom-Json
  $rewritten = 0

  foreach ($event in $json.hooks.PSObject.Properties) {
    foreach ($matcher in @($event.Value)) {
      foreach ($hook in @($matcher.hooks)) {
        if ($hook.type -ne "command") { continue }
        # 原来那条里的脚本路径原样保留（含 ${PLUGIN_ROOT} 之类的占位符），只换解释器
        $tail = $hook.command -replace '^\s*\S*python[0-9.]*(\.exe)?\s+', ''
        # 脚本路径必须加引号：占位符展开后可能带空格（用户名带空格在 Windows 上很常见）。
        # Codex 的 POSIX 那条原本就没加，在 macOS 上侥幸没事。只包路径那一段，
        # `; exit 0` 要留在引号外面 —— 包进去就变成 python 的参数了。
        if ($tail -notmatch '^"') { $tail = $tail -replace '^(\S+)', '"$1"' }
        $line = "$python $tail"
        if ($harness -eq "codex") {
          $hook | Add-Member -NotePropertyName "commandWindows" -NotePropertyValue $line -Force
        } else {
          $hook.command = $line
        }
        $rewritten += 1
      }
    }
  }
  if ($rewritten -eq 0) { throw "hooks.json 里一条 command 都没找到，布局可能变了：$file" }
  # 不用 -Encoding utf8：PowerShell 5.1 会写 BOM，而 JSON 解析器普遍不接受
  [System.IO.File]::WriteAllText($file, ($json | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
  return $rewritten
}

<#
把 dsh 插件 index.mjs 里的解释器默认值换成本机绝对路径。

dsh 不是 shell hook：它是 in-process 的 JS 插件，自己 `spawn` 一个 python 子进程。
这条链路在 Windows 上是五家里**最静默**的一种坏法 —— stderr 被 `ignore`，
而 `error` 事件只在 spawn 失败时触发，商店存根却是能成功启动的（打印错误、9009 退出），
于是没有任何一处会察觉。所以这里必须把路径钉死，不能指望 PATH。

改的是那一行的**默认值**，`AGENT_AVATAR_PYTHON` 环境变量仍然优先。
路径里用正斜杠并按 JS 字符串转义，Windows API 两种分隔符都收。
#>
function Set-NodeHookPython([string]$file, [string]$python) {
  $text = [System.IO.File]::ReadAllText($file)   # 按 UTF-8 读，理由同 Set-HookCommand
  $literal = '"' + ($python -replace "\\", "/") + '"'
  $pattern = 'process\.env\.AGENT_AVATAR_PYTHON \|\| "[^"]*"'
  if ($text -notmatch $pattern) { throw "index.mjs 里找不到解释器那一行，布局可能变了：$file" }
  $text = [regex]::Replace($text, $pattern, 'process.env.AGENT_AVATAR_PYTHON || ' + $literal)
  [System.IO.File]::WriteAllText($file, $text, (New-Object System.Text.UTF8Encoding($false)))
  return 1
}

# ---------------------------------------------------------------------------
# 冒烟自检 —— 验到「hook 真的跑通并写出了状态文件」
# ---------------------------------------------------------------------------

<#
喂一条真事件进去，看状态文件有没有落盘。

**必须验到落盘**，不能只验「进程退出码为 0」：hook 自己的设计就是永远 exit 0
（退出码 2 会 block），所以退出码根本反映不出它有没有干活。core 漏拷一个模块的表现
正是「安静地什么都没发生」—— 本轮所有坑都是这个形状。
#>
function Invoke-SmokeTest([string]$python, [string]$script, [string]$stateName,
                          [string]$event = '{"hook_event_name":"UserPromptSubmit","session_id":"smoke"}') {
  $scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-avatar-smoke-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $scratch | Out-Null
  try {
    $previous = $env:TMPDIR
    $env:TMPDIR = $scratch
    # $OutputEncoding 决定往子进程 stdin 写什么字节。用户 profile 里常见的
    # `$OutputEncoding = [Text.Encoding]::UTF8` 带 BOM 前导符，会在 JSON 开头塞三个字节，
    # 于是 hook 拿到的第一行不是 `{` —— 自检就不再是在喂「harness 会喂的东西」了。
    # 这里强制成不带 BOM 的 UTF-8，只在自检期间生效。
    $previousEncoding = $OutputEncoding
    # 别在插件目录里留下 __pycache__：这棵树是要分发的，字节码是本机 Python 版本专属的垃圾
    $previousBytecode = $env:PYTHONDONTWRITEBYTECODE
    $env:PYTHONDONTWRITEBYTECODE = "1"
    $global:OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    try { $event | & $python $script | Out-Null }
    finally {
      $env:TMPDIR = $previous
      $env:PYTHONDONTWRITEBYTECODE = $previousBytecode
      $global:OutputEncoding = $previousEncoding
    }
    if ($LASTEXITCODE -ne 0) { throw "hook 非零退出（$LASTEXITCODE）—— core 可能没拷全" }
    if (-not (Test-Path -LiteralPath (Join-Path $scratch $stateName))) {
      throw "没写出状态文件 $stateName —— core 可能没拷全"
    }
  } finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
}

<#
dsh 多验一件事：cordis 会 import 那个 JS 插件，所以它得**真的导得进来**且导出 apply。
python 入口的落盘由上面那个通用自检负责（dsh 的回合起点是 pre_llm_call）。
#>
function Invoke-NodeImportCheck([string]$file) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "PATH 里没有 node —— dsh 是 Node 程序，它的插件自检需要 node"
  }
  $url = ([uri](Resolve-Path -LiteralPath $file).ProviderPath).AbsoluteUri
  & node --input-type=module -e "import('$url').then(m => { if (typeof m.apply !== 'function') process.exit(1) }, () => process.exit(1))"
  if ($LASTEXITCODE -ne 0) { throw "dsh 的 index.mjs 导不进来或没有 apply" }
}

<#
Hermes 是包形态，没有 stdin 入口，所以直接按包加载一次：漏拷 state_machine.py 就在这里炸。
（Hermes 跑在自己的解释器里，这里用哪个 python 只是「能不能加载」的代理验证。）
#>
function Invoke-HermesLoadCheck([string]$python, [string]$target) {
  $scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-avatar-smoke-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $scratch | Out-Null
  try {
    $probe = Join-Path $scratch "probe.py"
    $code = @'
import importlib.util, sys
target = sys.argv[1]
spec = importlib.util.spec_from_file_location(
    "agent_avatar_plugin", target + "/__init__.py", submodule_search_locations=[target])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
assert module.HOOKS, "plugin exposes no hooks"
'@
    [System.IO.File]::WriteAllText($probe, $code, (New-Object System.Text.UTF8Encoding($false)))
    $previousBytecode = $env:PYTHONDONTWRITEBYTECODE
    $env:PYTHONDONTWRITEBYTECODE = "1"
    try { & $python $probe $target } finally { $env:PYTHONDONTWRITEBYTECODE = $previousBytecode }
    if ($LASTEXITCODE -ne 0) { throw "hermes 插件包加载失败 —— core 可能没拷全" }
  } finally { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------

$python = Resolve-Python
if (-not $python) {
  Write-Host ""
  Write-Host "找不到可用的 Python。" -ForegroundColor Red
  Write-Host ""
  Write-Host "  注意：Windows 上的 ``python3`` 通常是应用商店的占位程序（0 字节），"
  Write-Host "  看起来存在、其实跑不起来。所以要装一个真的。"
  Write-Host ""
  Write-Host "  方式一 自己跑一条命令："
  Write-Host "    winget install Python.Python.3.13"
  Write-Host ""
  Write-Host "  方式二 把下面这句贴给你的 agent："
  Write-Host "    帮我用 winget 装 Python 3.13，装完把 python 的完整路径告诉我"
  Write-Host ""
  exit 1
}

$hookPython = ConvertTo-HookPath $python
Write-Host "使用的 Python：$python"
if ($hookPython -ne ($python -replace "\\", "/")) { Write-Host "  （路径带空格，命令行里改用 8.3 短路径：$hookPython）" }

switch ($Harness) {
  "claude-code" {
    Assemble-ClaudeCode $Target
    $count = Set-HookCommand (Join-Path $Target "hooks/hooks.json") $hookPython $Harness
    Invoke-SmokeTest $python (Join-Path $Target "hooks/agent-avatar-hook.py") "agent-avatar-state.claude-code.json"
  }
  "codex" {
    Assemble-Codex $Target
    $count = Set-HookCommand (Join-Path $Target "hooks.json") $hookPython $Harness
    Invoke-SmokeTest $python (Join-Path $Target "scripts/agent-avatar-hook.py") "agent-avatar-state.codex.json"
  }
  "workbuddy" {
    Assemble-WorkBuddy $Target
    $count = Set-HookCommand (Join-Path $Target "hooks/hooks.json") $hookPython $Harness
    # WorkBuddy 的 SessionStart 不当重置（见 pascal_events 的注释），拿它自检永远写不出文件。
    # 喂 UserPromptSubmit —— 那是它真实的回合起点，也正好是自检的默认事件。
    Invoke-SmokeTest $python (Join-Path $Target "hooks/agent-avatar-hook.py") "agent-avatar-state.workbuddy.json"
  }
  "dsh" {
    Assemble-Dsh $Target
    # 这里给的是**原始绝对路径**，不是 8.3 短路径：dsh 用 spawn 直接起进程、不过 shell，
    # 带空格的路径作为 argv[0] 本来就没问题。短路径只在「要写进命令行」时才需要。
    $count = Set-NodeHookPython (Join-Path $Target "index.mjs") $python
    Invoke-NodeImportCheck (Join-Path $Target "index.mjs")
    Invoke-SmokeTest $python (Join-Path $Target "agent-avatar-hook.py") "agent-avatar-state.dsh.json" `
      '{"hook_event_name":"pre_llm_call","session_id":"smoke","turn_id":"1"}'
  }
  "hermes" {
    # 唯一不用改解释器的一家：纯 Python in-process，跑在 Hermes 自己的解释器里，不 spawn。
    Assemble-Hermes $Target
    $count = 0
    Invoke-HermesLoadCheck $python $Target
  }
}

if ($count -gt 0) {
  Write-Host "已组装 $Harness → $Target（改写了 $count 条 hook 命令，冒烟自检通过）"
} else {
  Write-Host "已组装 $Harness → $Target（这家不需要改解释器，冒烟自检通过）"
}
