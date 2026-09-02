import { cp, mkdir } from "node:fs/promises";
import { createReadStream, statSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";

function localAssets(): Plugin {
  return { name: "local-avatar-assets",
    /**
     * dev 也要看到 release 的样子：dist 里没有 `models/`，dev 就不该服务开发树里的 `models/`。
     *
     * Vite 默认把项目根当静态根，于是 `/models/index.json` 在 dev 下依然能取到，
     * 菜单里就多出几个「随包模型」，而它们在 `.app` 里根本不存在 —— 实机撞到过：
     * 数据目录里 2 个文件夹，菜单里 5 个（2 个是这里漏出去的开发树模型）。
     * M5 随包自制模型时，这里与下面 closeBundle 的拷贝清单**一起**放开。
     */
    configureServer(server) {
      server.middlewares.use("/models", (_request, response) => { response.statusCode = 404; response.end(); });
    },
    async closeBundle() {
    // **不再随包分发任何 Live2D 模型**（晓 2026-08-28 定）。第三方模型的再分发许可
    // 各不相同，而我们要在 GitHub 公开发布 —— 用户自备模型，装进数据目录即可。
    // `models/` 仍可存在于开发树里（已 gitignore），但不进 dist、不进 .app。
    // Cubism Core 例外：它在官方 RedistributableFiles.txt 的可再分发清单内。
    await mkdir(resolve("dist/vendor"), { recursive: true });
    await cp(resolve("vendor"), resolve("dist/vendor"), { recursive: true });
  }};
}

/**
 * dev 专用：把 `/user-models/` 指到用户数据目录。
 *
 * release 下这条路由由内嵌的 `static_server` 提供，但它只在 release 构建里启用
 * （`#[cfg(not(debug_assertions))]`），dev 下页面是 Vite 发的 —— 不补这一段，
 * 用户装的模型在开发模式下一律 404，等于没法验证。
 */
/**
 * 用户数据目录，必须和 Rust 侧 `app_data_dir()` 算出同一个位置。
 *
 * 原来这里写死了 macOS 的 `~/Library/Application Support/...`，Windows 上于是永远指到一个
 * 不存在的路径 —— 后果正是下面那段注释警告的那件事：**dev 模式下用户装的模型一律 404**，
 * 菜单里空空如也，而且没有任何报错。release 不受影响（那条路由由内嵌 static_server 提供，
 * 它走的是 Rust 的 app_data_dir）。
 */
function appDataDir(identifier: string): string {
  if (process.platform === "win32") return resolve(process.env.APPDATA ?? resolve(homedir(), "AppData/Roaming"), identifier);
  return resolve(homedir(), "Library/Application Support", identifier);
}

function userModels(): Plugin {
  const root = resolve(appDataDir("io.github.joyparkray.agentavatar"), "models");
  const types: Record<string, string> = {
    json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", wav: "audio/wav", mp3: "audio/mpeg",
  };
  return {
    name: "user-models-dev",
    configureServer(server) {
      server.middlewares.use("/user-models", (request, response, next) => {
        const raw = decodeURIComponent((request.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const target = resolve(root, raw);
        // 与 Rust 侧同一条规矩：解析后必须仍在根目录内
        const inside = relative(root, target);
        if (!raw || inside.startsWith("..") || inside.startsWith(sep)) { response.statusCode = 403; response.end(); return; }
        try {
          if (!statSync(target).isFile()) throw new Error("not a file");
        } catch { next(); return; }
        response.setHeader("Content-Type", types[target.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream");
        createReadStream(target).pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [localAssets(), userModels()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 不监视 Rust 的构建产物：Windows 上 `target/debug/deps/*.dll` 在链接期间被独占，
    // chokidar 一碰就抛 EBUSY，而这个错会让整个 vite 进程崩掉 ——
    // 表现是 `npm run tauri dev` 刚起来就退出（beforeDevCommand 非零退出）。
    // macOS 不锁文件，所以一直没暴露；忽略它对两个平台都只有好处（少一堆无谓的重扫）。
    watch: { ignored: ["**/src-tauri/target/**"] },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), "index.html"),
        gallery: resolve(process.cwd(), "gallery.html"),
        settings: resolve(process.cwd(), "settings.html"),
      },
    },
  },
});
