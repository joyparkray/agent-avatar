# Agent Avatar connectors

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

让桌面上的形象跟着你的 agent 动：它在思考、在跑工具、在等子 agent 时，形象会换表情。

这里是五家 agent harness 的**插件本体**。版本 {{VERSION}}。

> **纯观察者**：它们只读事件、只写一个本地状态文件（在 `$TMPDIR` / `%TEMP%` 下）。
> 不返回任何指令、不拦截工具、不参与授权决定。想确认它到底做了什么，每个入口都在
> `plugins/<harness>/agent-avatar/` 里 —— 几百行 Python。

---

## 你多半用不到这一页

**app 会替你装。** 打开 Agent Avatar → 设置 → Agent，在你用的那一家旁边点「安装」。
连接器和它需要的 Python 都在这个应用里，不联网、不下载；登记那一步调的是**你那家
harness 自己的命令行**。失败时它会告诉你卡在第几步、以及那家 harness 自己说了什么。

这一页是给 app 够不着的那些情况准备的：

- 你的 harness 跑在 app 看不见的地方 —— **WSL、容器、另一台机器**；
- 你想**先读一遍命令再跑**，或者手工修一个装坏了的；
- 你在把 Agent Avatar 打包进我们没想到的什么东西里。

---

## 先拿到文件

克隆 app 仓库，构建出连接器树：

```
git clone https://github.com/{{REPO}} agent-avatar
cd agent-avatar
sh connectors/build-bundle.sh ./connector-tree
cd connector-tree/marketplace
```

这一步需要一个 shell 和一个 Python —— 就是你接下来要给连接器用的那个。构建过程会
**逐家跑一次冒烟自检**，所以能装配出来的树，它的核心就是完整的。

（构建只需要一个 shell 和一个 Python —— 这棵树是从本仓库组装出来的，不下载任何东西。）

---

## 安装

五家里有三家读一个 *marketplace*（一个带清单的目录）。它们的清单文件名互不相同，
所以同一个目录能同时服务三家。另外两家装法不同，各有一节。

### Claude Code

```
python localize.py claude-code
claude plugin marketplace add ./
claude plugin install agent-avatar@agent-avatar
```

`localize.py` 会把**正在跑它的那个解释器**写进 hook 的命令行。Windows 上这一步不是可选的：
那里的 `python3` **不是 Python** —— 它指向一个 0 字节的微软商店占位程序，启动、打印
"Python was not found"、以 9009 退出。9009 不是 2，所以没有任何一家 harness 会当成失败，
唯一的症状是形象永远不动。macOS 上也值得跑：它会把解释器钉死，而不是留着
`/usr/bin/python3` —— 在没装 Xcode 命令行工具的 Mac 上那是个会弹安装框的占位程序。

装完**开一个新会话** —— 插件是在会话启动时加载的。

### WorkBuddy / CodeBuddy Code

形状一样：把 `claude` 换成 `codebuddy`，`localize.py` 的参数用 `workbuddy`。

🔴 **装进哪个配置目录很要紧。** 同一个 CLI 有两个 home：**app 读 `~/.workbuddy`**，
而独立 CLI 默认读 `~/.codebuddy`。装错那个是所有故障里最让人迷惑的一种 ——
**命令行怎么测都正常，app 里完全没反应**。如果你只用 app，装之前把
`CODEBUDDY_CONFIG_DIR` 指到 `~/.workbuddy`。

装完**重启 WorkBuddy app**（插件在启动时才加载）。

### Codex

```
python localize.py codex
codex plugin marketplace add ./
codex plugin add agent-avatar@agent-avatar
```

🔴 Codex 的动词是 **`plugin add` / `plugin remove`**，不是 install/uninstall。

🔴 **Windows 上 `codex` 不在 PATH 里，但它确实存在。** ChatGPT app 自带它，装在
`%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe` —— 目录名是构建哈希，取最新的那个、
用绝对路径调。（我们曾经有很长一段时间以为 Windows 版根本没有这个 CLI，并据此写了一整条
改配置文件的岔路。那是错的，而且更糟：那条路是个**半装** —— `codex plugin add` 还会把插件
拷进 `~/.codex/plugins/cache/…` 并把**那一份**报成真正加载的副本，手改 `config.toml`
永远产生不出它。）

装完有两步只能你自己做：

1. **完全退出再打开 ChatGPT app** —— 插件在启动时才被发现。
2. **在 Codex 会话里跑 `/hooks`，逐条授信。** 启用插件**不会**自动信任它的 hook，
   未授信的 hook 会被静默跳过。这是安全设计，不是故障。信任是按 hook 的**内容哈希**记的，
   所以 connector 每次升级之后都要重新授信一次。

### DeepSeek Harness（dsh）

dsh 根本没有插件 CLI：登记本身就是它 patch 文件里的一条。

```
python localize.py dsh --register
```

它会写 `$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh`），动手前先备份原文件。这一步是幂等的
—— 连早先手工粘贴进去、没有标记的那种条目也认得出来 —— `--unregister` 原样撤销。
只想看看那一段而不写文件，用 `--print-registration`。

那一条的 `name` **必须是 `file:///` URL**：dsh 会把它当 ES 模块标识符去 import，而 Node 会
把 `C:/…` 的盘符当成协议名。脚本写得对，手拼的十有八九不对，而且**错了没有任何声音**
（这条链路把插件的 stderr 丢弃了）。

### Hermes

Hermes **只认 git 源** —— 一个 URL、`owner/repo`，或者它索引里的一个名字。它不接受本地目录；
而且 `file://` **不支持** `owner/repo/子目录` 那种写法：你指给它什么，它就整个 clone 下来，
所以插件的 `plugin.yaml` 必须在那个仓库的**根**上。

那就现造一个。在构建出来的树里：

```
cp -r plugins/hermes/agent-avatar /tmp/agent-avatar-hermes
cd /tmp/agent-avatar-hermes && git init -q && git add -A && git commit -qm bundled
hermes plugins install "file:///tmp/agent-avatar-hermes" --enable
hermes plugins doctor agent-avatar
```

`doctor` 应当报 `OK: runtime discovery, manifest parsing, import, and registration
passed` 以及 `10 hook(s)`。app 就是这么做的 —— 它靠这条路让装 Hermes 也不需要联网。

🔴 **别把 Hermes 指向 app 仓库里那个插件源码目录。** 那里没有 `state_machine.py`
（共享核心是构建时才拷进去的），装出来的插件 import 不了自己。

Hermes 是五家里唯一不需要本地化的：它的插件是 in-process 的 Python 包，跑在 Hermes 自己的
解释器里，不 spawn 任何进程。

---

## 怎么确认它真的通了

🔴 **别以「命令没报错」为准。** hook 被设计成**永远 exit 0**（退出码 2 在 Claude Code 和
Codex 里表示拦截，会挡住你的 agent），所以它的退出码什么也证明不了。

看**状态文件**：

| | 路径 |
|---|---|
| Windows | `%TEMP%\agent-avatar-state.<harness>.json` |
| macOS / Linux | `$TMPDIR/agent-avatar-state.<harness>.json`（没有 `TMPDIR` 就是 `/tmp`） |

（Hermes 沿用无后缀的老路径 `agent-avatar-state.json`。）

让 agent 做一件会调用工具的事，文件里的 `state` 应当依次走过：

```
idle → writing → executing → writing → idle
```

出错时还会有一个 `agent-avatar-diagnostic.<harness>.json`，记着时间、版本、
**它用的那个解释器**和错误内容 —— 「装了但不动」十有八九是解释器不对。

## 装了但什么都没发生？

按概率排：

1. **还没开新会话** —— 插件在会话启动时加载，已经在跑的会话不会自己加载。
2. **还有一步人工的没做** —— Codex 要 `/hooks` 授信，WorkBuddy 要重启 app，
   Hermes 要 `gateway restart`。
3. **杀毒软件把文件删了。** 已知卡巴斯基会把这类文件判成 `PDM:Trojan.Win32.Generic` ——
   那是对「未签名脚本修改另一个应用的配置」这个**行为**的误报。去它的隔离区找一下。
   症状和装失败完全一样：文件就是没了。
4. **没有可用的 Python。** Windows 上 `python3` 常常就是上面说的那个占位程序。
   `python -c "import sys; print(sys.executable)"` 会告诉你手上到底是什么。

## 卸载

用各家自己的命令，插件名要用**全名**：

```
claude    plugin uninstall agent-avatar@agent-avatar   &&  claude    plugin marketplace remove agent-avatar
codebuddy plugin uninstall agent-avatar@agent-avatar   &&  codebuddy plugin marketplace remove agent-avatar
codex     plugin remove    agent-avatar@agent-avatar   &&  codex     plugin marketplace remove agent-avatar
```

🔴 短名在 **WorkBuddy 上会直接失败**（`Marketplace undefined is not found.`）而插件原样留着。
它可能看起来成功了 —— 因为下一步删 marketplace 会顺带把插件带走 —— 直到哪天不再顺带为止。

dsh：`python localize.py dsh --unregister`。

Hermes **要先 disable 再 remove**：

```
hermes plugins disable agent-avatar
hermes plugins remove  agent-avatar
```

单独跑 `remove` 会把条目留在 `config.yaml` 的 `plugins.enabled` 里，于是列表显示启用、
实际什么都加载不了。而且 Windows 上 `remove` 只做一半：它把目录改名成
`.agent-avatar.remove-xxxx` 之后删不掉（它 clone 下来的 git pack 文件是只读的），
所以要去掉只读属性、手动删掉 `%LOCALAPPDATA%\hermes\plugins\` 下那个残骸。
这是 Hermes 自己在 Windows 上的行为，不是插件的问题 —— app 会替你清掉。

## 这里面有什么

```
plugins/<harness>/agent-avatar/    每家一棵插件树
localize.py                        把这台机器的解释器写进 hook
.claude-plugin/  .agents/  .codebuddy-plugin/    三家的 marketplace 清单
```

五棵树各自带着同一份核心（`state_machine.py`）的副本，它把各家的事件翻译成同一套状态词表。
适配器各不相同，状态机不能 —— 它是和 app 之间的契约，在那儿分叉的表现是
「形象显示了错的状态」，而那种事几周都不会有人发现。
