# 快速上手 —— 10 分钟内让形象跟着你的 agent 动

这条路径是给「只想下载 app、没 clone 源码」的你。下面所有步骤只需 app + 一次小下载。

> 想从源码构建？见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 1. 安装并启动

1. 从 [Releases](../../releases) 按你的芯片下载：
   - Apple 芯片（M1/M2/M3/M4）：`Agent-Avatar-1.0.0-Apple-Silicon.dmg`
   - Intel：`Agent-Avatar-1.0.0-Intel.dmg`
2. 打开 `.dmg`，把 `Agent Avatar.app` 拖进「应用程序」。
3. 直接双击打开 —— 包已签名并通过 Apple 公证，不需要右键。
4. 启动。会出现一张卡片提示你装模型 —— 没有模型就看不到形象。

## 2. 装一个模型

app 不内置任何模型。下载一个 **Live2D 官方免费示例模型**，解压后，把**解压出来的模型文件夹**拖进**设置 → 模型**（或直接拖到引导卡片上）。详见 [MODELS.md](MODELS.md)。

## 3. 接上你的 agent（最省事的方式）

形象只有在「知道你的 agent 在干嘛」时才会动 —— 这需要一个 **connector**（agent harness 的小插件）。有两种装法：

### 方式 A —— 在 app 里一键装（推荐所有人，不用开终端）

装好模型、形象出现之后，会自动弹出**接入向导**；关掉了也没关系，
右键形象 → **设置 → Agent → 接入** 是同一个界面。

1. 找到你在用的那一家（Claude Code / Codex / Hermes / DeepSeek / WorkBuddy）。
2. 点 **安装**。app 会自己下载 connector 包、解压、运行对应的安装脚本，
   过程中那一行会显示「正在下载 / 正在解压 / 正在安装」。
3. 装完那一行会显示**还需要你做的步骤**（有的家没有，见下表）。

每一行还有 **安装说明** 按钮，装之前就能看这一家会要求你做什么。
状态分三档：`插件未安装` / `插件已安装，需人工配置` / `插件正常，已连通` ——
第二档就是「文件装好了但对方还没启用/授信/重启」，最常见的卡点。

4. **装完一定做你那一家的「装完步骤」** —— 这是「装了没反应」最常见的原因：

   | Harness | 装完之后 |
   |---|---|
   | Claude Code | 无（装好即信任） |
   | DeepSeek Harness | 无（热加载） |
   | Hermes | `hermes plugins enable agent-avatar` |
   | WorkBuddy | **重启 app** |
   | Codex | **在 Codex 会话里运行 `/hooks` 并逐条授信** |

### 方式 B —— 手动装

app 够不着你的 harness 时用这条：它跑在 **WSL、容器、或另一台机器**上；或者你想先把命令
读一遍再跑。

命令都写在 [连接器 README](../connectors/marketplace-README.zh.md) 里 —— 和 app 替你跑的
是同一批。要么克隆仓库自己构建那棵树，要么从 [Releases](../../releases) 下
`agent-avatar-connectors.zip` 解压。

   `connectors/` 与 `bridge/` 两棵目录**必须保持解压后的相对位置**，脚本靠相对路径找 core。
3. 同样要做上面那张表里的「装完之后」。

clone 了仓库的开发者用仓库里同样的脚本即可。

## 4. 告诉形象跟着哪个 agent

右键形象 → **状态来源** → 选你的 harness（或 *Auto*）。装对的话，形象现在会演出
「思考中 / 执行中 / 等待中 / 出错」，并在 agent 出声时动嘴。

## 排查

装好了却没反应？几乎都是**装完步骤漏了**（尤其 Codex 的 `/hooks` 和 WorkBuddy 的重启）。
见 [CONNECTORS.md](CONNECTORS.md) 和 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
