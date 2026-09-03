/**
 * 打免安装（绿色）压缩包。
 *
 * Tauri **没有** Windows 的免安装目标：`bundle.targets` 只认 `nsis` / `msi`，两个都是安装器。
 * 所以这一步自己做。前端资源在编译期就嵌进了 exe，WebView2 是系统组件不随包分发。
 *
 * 🔴 **但它不再只是一个 exe 了。** app 开始自带 connector 和一个 Python 解释器之后
 *（`tauri.conf.json` 的 `bundle.resources`），那份 `resources/` 必须跟着进包 —— 否则免安装版
 * 用户一点「安装」就撞上「app 里没有连接器树」。安装器那条路是 Tauri 自己拷的，
 * 这条路没人替我们拷，而两条路的产物看起来一模一样，所以这个洞是**静默**的：
 * 2026-09-03 实测时便携包只有 3.77 MB、里面就一个 exe 加一份说明。
 *
 * 用法：先 `npm run tauri build`，再 `node scripts/pack-portable.mjs`。
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const releaseDir = join(root, "src-tauri", "target", "release");
const exe = join(releaseDir, "agent-avatar.exe");

if (!existsSync(exe)) {
  console.error(`找不到 ${exe}\n先跑一次 npm run tauri build`);
  process.exit(1);
}

const name = `Agent-Avatar-${version}-windows-x64-portable`;
const stageRoot = join(releaseDir, "portable");
const stage = join(stageRoot, name);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

copyFileSync(exe, join(stage, "Agent Avatar.exe"));

// 打包资源：连接器树 + 自带的解释器。运行时是按**可执行文件的位置**去找它们的，
// 所以它必须和 exe 同级，目录名也不能改。
const resources = join(releaseDir, "resources");
if (!existsSync(resources)) {
  console.error(`找不到 ${resources}\n先跑 connectors/build-bundle.sh 与 fetch-python.sh，再 npm run tauri build`);
  process.exit(1);
}
cpSync(resources, join(stage, "resources"), { recursive: true });

// 🔴 后置检查：装 connector 的代码是按**这几个相对路径**去找东西的
//（见 connector_install.rs 的 `bundled`）。漏了任何一个，用户点「安装」才会发现，
// 而那时的报错是「app 里没有连接器树」—— 一个看起来像我们代码坏了的说法。
for (const needed of ["resources/connectors/marketplace", "resources/connectors/python"]) {
  if (!existsSync(join(stage, needed))) {
    console.error(`免安装包里缺 ${needed} —— 装 connector 会直接失败`);
    process.exit(1);
  }
}

// 说明写进包里：免安装版没有安装器那一步，用户拿到的就是一个 exe，
// 而「设置和模型存在哪」「怎么装模型」这两件事没人会去仓库里翻文档。
writeFileSync(join(stage, "读我 README.txt"), [
  `Agent Avatar ${version} —— Windows 免安装版`,
  "",
  "【运行】",
  "  双击 “Agent Avatar.exe” 即可，不需要安装。",
  "  首次运行 Windows 可能提示“无法验证发布者”（本版本未签名）——",
  "  点“更多信息”→“仍要运行”。",
  "",
  "【安装模型】",
  "  本程序不内置 Live2D 模型。",
  "  右键人物 → 设置 → 模型，把解压后的模型文件夹拖进去即可。",
  "  文件夹名带空格、表情没登记之类的问题，导入时会自动处理。",
  "",
  "【数据存放位置】",
  "  设置与已装模型不在本目录里，而在：",
  "    %APPDATA%\\io.github.joyparkray.agentavatar",
  "  所以换目录、换盘符都不影响；要彻底清理请手动删除该文件夹。",
  "",
  "【系统要求】",
  "  Windows 10 或更高版本 + WebView2 运行时（Win11 已内置；",
  "  Win10 若缺失，可从微软官网安装 “Evergreen Bootstrapper”）。",
].join("\r\n"), "utf8");

const zip = join(releaseDir, `${name}.zip`);
rmSync(zip, { force: true });
// 用 PowerShell 的 Compress-Archive：不引第三方依赖，Windows 自带
execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
  `Compress-Archive -Path '${stage}' -DestinationPath '${zip}' -CompressionLevel Optimal`], { stdio: "inherit" });

console.log(`\n免安装包: ${zip}`);
console.log(`大小: ${(statSync(zip).size / 1024 / 1024).toFixed(2)} MB`);
