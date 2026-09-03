# Agent Avatar connectors

让桌面形象跟着你的 agent 变表情：它在想、在跑工具、在等子代理，形象就换表情。

这个仓库是五家 agent harness 的**插件本体**，同时也是其中三家的 plugin marketplace
（三份清单文件名互不相同，互不干扰）。版本 {{VERSION}}。

> **纯观察者**：这些插件只读事件、写一个本地状态文件（`$TMPDIR`/`%TEMP%` 下），
> 从不返回指令、不拦工具、不参与审批。要看它到底做了什么，
> 每家的入口都在 `plugins/<harness>/agent-avatar/` 下，一共几百行 Python。

---

## 怎么装

**把对应的那一段整个贴给你的 agent** —— 你本来就坐在一个能执行命令的 agent 面前，
让它去装比你手动敲快也少出错。命令都是钉死的，你可以先自己读一遍再让它跑。

（也可以自己照着敲，它们就是普通命令。）

### Claude Code

**macOS / Linux**

```
claude plugin marketplace add {{REPO}}
claude plugin install agent-avatar@agent-avatar
```

**Windows** —— 多一步「本地化」，因为 `python3` 在 Windows 上不是 Python
（它是一个 0 字节的应用商店占位程序，能启动、打印「Python was not found」、然后退出）：

```
git clone https://github.com/{{REPO}} agent-avatar-connectors
cd agent-avatar-connectors
python localize.py claude-code
claude plugin marketplace add ./
claude plugin install agent-avatar@agent-avatar
```

装完**新开一个会话**（或在会话里 `/reload-plugins`）才生效。

### WorkBuddy / CodeBuddy Code

与 Claude Code 完全同形，把 `claude` 换成 `codebuddy`、`localize.py` 的参数换成 `workbuddy`。

🔴 **装进哪个配置目录是关键**：同一个 CLI 有两个 home —— **app 读 `~/.workbuddy`**，
独立 CLI 默认读 `~/.codebuddy`。装错的表现最迷惑人：**命令行怎么测都正常、app 里完全没反应**。
只用 app 的话，先设 `CODEBUDDY_CONFIG_DIR` 指到 `~/.workbuddy` 再装。

装完**重启 WorkBuddy app**（插件在启动时才加载）。

### Codex

**macOS / Linux**

```
codex plugin marketplace add {{REPO}}
codex plugin install agent-avatar@agent-avatar
```

**Windows** —— ChatGPT app **不带 codex CLI**，所以要手工登记（脚本会把要加的两段算好）：

```
git clone https://github.com/{{REPO}} agent-avatar-connectors
cd agent-avatar-connectors
python localize.py codex
python localize.py codex --print-registration
```

把最后一条打印出来的两段追加到它指出的那个 `config.toml`（先备份），然后**完全退出 ChatGPT app 再打开**。

🔴 **最后一步只能你自己点**：在 Codex 会话里跑 `/hooks`，逐条信任 Agent Avatar 的 hook。
启用插件**不会**自动信任它的 hook，而未授信的 hook 会被**静默跳过** ——
表现就是「插件明明是启用的，但形象不动」。这是安全设计，不是故障。
（connector 升级后要重新授信：Codex 按 hook 的内容哈希记忆信任。）

### DeepSeek Harness (dsh)

dsh 没有「插件市场」式的安装命令，装法是往它的用户 patch 层加一条 entry：

```
git clone https://github.com/{{REPO}} agent-avatar-connectors
cd agent-avatar-connectors
python localize.py dsh            # 仅 Windows 需要
python localize.py dsh --print-registration
```

把打印出来的那一段追加到 `$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh`，先备份）。
那个文件被 dsh 的 HMR 监视着 —— **正在跑的 dsh 会热加载，不用重启**。

> Windows 上那个 `name` **必须是 `file:///` 开头的 URL**：dsh 把它当 ESM specifier 直接
> `import()`，而 Node 会把 `C:/…` 的盘符当成协议名（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）。
> 上面那条命令已经算好了，别自己拼。

### Hermes

Hermes 有自己的插件 CLI（只认 git 来源，支持子目录，能钉死 commit SHA）：

```
hermes plugins install {{REPO}}/plugins/hermes/agent-avatar --enable
hermes plugins doctor agent-avatar
hermes gateway restart
```

`doctor` 应当报 `OK: runtime discovery, manifest parsing, import, and registration passed`
以及 `10 hook(s)`。

> ⚠️ **它的安全扫描可能拦下这个插件**，命中的是
> `state_machine.py` 里 `if executable == "sudo":` 那一行，判为 `privilege_escalation`。
> 那段是**命令行解析器**：跳过 `env` / `sudo` / shell 这类包装命令，找出真正在跑的程序，
> 好让形象说「在跑 git」而不是「在跑 sudo」。纯字符串解析，从不执行任何东西。
> 放不放行请**你自己判断**（`--force` 覆盖）—— 那道门存在的意义就是让人看一眼再点头。

Hermes 是五家里唯一不需要「本地化」的：它的插件是 in-process 的 Python 包，
跑在 Hermes 自己的解释器里，不 spawn 任何子进程。

---

## 怎么确认它真的通了

🔴 **不要看「命令有没有报错」。** hook 的设计是**永远 exit 0**
（退出码 2 在 Claude Code / Codex 里是 block，会拦住你的 agent），所以退出码说明不了任何事。

要看**状态文件**：

| | 路径 |
|---|---|
| Windows | `%TEMP%\agent-avatar-state.<harness>.json` |
| macOS / Linux | `$TMPDIR/agent-avatar-state.<harness>.json`（没有 `TMPDIR` 就是 `/tmp`） |

（Hermes 沿用无后缀的 `agent-avatar-state.json`。）

让 agent 干一件带工具调用的事，这个文件的 `state` 应当走过：

```
idle → writing → executing → writing → idle
```

出错时还会有一份 `agent-avatar-diagnostic.<harness>.json`，里面记着时间、版本、
**它用的解释器路径**和错误内容 —— 「装了但不动」十有八九是解释器不对。

## 装了却一直不动？

按可能性从高到低：

1. **还没开新会话** —— 插件在会话启动时加载，已经在跑的会话不会自己加载。
2. **没做完那一步人工动作** —— Codex 要 `/hooks` 授信、WorkBuddy 要重启 app、
   Hermes 要 `gateway restart`。
3. **杀毒软件把文件删了。** 已知卡巴斯基会把这类文件判成 `PDM:Trojan.Win32.Generic`
   并**直接删除**，而删完之后表现就是「装了但不动」。去它的隔离区找一下。
4. **这台机器上没有可用的 Python**：`python -c "import sys; print(sys.executable)"`。
   Windows 上 `python3` 常常是那个 0 字节的商店占位程序。
   没有的话：`winget install Python.Python.3.13`（Windows）/ `xcode-select --install`（macOS）。

## 卸载

各家用自己的命令（`claude plugin uninstall agent-avatar` / `codebuddy plugin uninstall
agent-avatar` / `hermes plugins remove agent-avatar`），Codex 从 `config.toml` 里删掉那两段，
dsh 从 `cordis.patch.yml` 里删掉 `# >>> agent-avatar (managed) >>>` 那一段。

## 这里面有什么

```
.claude-plugin/marketplace.json      Claude Code 读这份
.agents/plugins/marketplace.json     Codex 读这份
.codebuddy-plugin/marketplace.json   WorkBuddy 读这份
plugins/<harness>/agent-avatar/      五家各自的插件树
localize.py                          Windows 上把解释器换成本机绝对路径那一步
```

`localize.py` 改完会**当场自检**：喂一条真事件进去，确认状态文件真的落盘才算成功。

桌面应用本体在 [joyparkray/agent-avatar](https://github.com/joyparkray/agent-avatar)。
connector 和 app 分开发布 —— 改 connector 不需要你重装 app。

MIT。
