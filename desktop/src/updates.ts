/**
 * 「有没有新版本」——**只查一个版本号，不下载任何东西**。
 *
 * 🔴 这条曾经被我们自己否掉过，理由是「app 不下载，所以不联网」。那是把两件事混成了一件：
 * **查一个版本字符串和下载并执行代码完全不同** —— 前者没有 Mark of the Web（那是浏览器、
 * 邮件客户端这类下载方主动打上的）、没有解压、没有脚本执行，也就没有那条杀软误报链。
 * 真正让我们的安装脚本被卡巴斯基删掉的是**行为**（未签名脚本改另一个应用的配置），
 * 和文件从哪来无关。
 *
 * 所以这里查，但**只查**：拿到新版本号就告诉用户，装不装、去哪装由他自己决定。
 *
 * 这个文件里全是纯函数，网络那一下由调用方注入 —— 版本比较和「该不该查」的判断是这里最
 * 容易错的两处，它们不该需要一个网络环境才能测。
 */

/** GitHub Releases 的公开接口。不带鉴权，只读一个 tag 名。 */
export const RELEASES_API = "https://api.github.com/repos/joyparkray/agent-avatar/releases/latest";

/** 两次自动检查之间至少隔多久。手动点「检查更新」不受它限制。 */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 网络那一下最多等多久。等不到就当作查不到 —— 它永远不该拖住设置页。 */
export const CHECK_TIMEOUT_MS = 8000;

export interface UpdateInfo {
  /** 远端最新的版本号，读不到时为 null */
  latest: string | null;
  /** 比当前版本新才为 true */
  newer: boolean;
  /** 发布页地址，给「去看看」用 */
  url?: string;
}

/**
 * 逐段比数字。段里读不出数字就按 0 算（`1.0.0-rc1` 里的 `0-rc1` 那种）。
 *
 * 返回负数表示 left 更旧。
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.replace(/^v/i, "").split(".").map(part => Number.parseInt(part, 10) || 0);
  const a = parse(left), b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * 该不该发起一次**自动**检查。
 *
 * 关掉开关时永远不查 —— 这一条比什么都重要：用户关掉它就是不希望这个应用去联网，
 * 那我们连一次都不能发。
 */
export function shouldCheck(enabled: boolean, lastCheckedAt: number | null | undefined,
                            now: number = Date.now()): boolean {
  if (!enabled) return false;
  if (!lastCheckedAt) return true;
  // 时钟往回跳过（改过系统时间、跨时区）时也要能继续查，所以取绝对值
  return Math.abs(now - lastCheckedAt) >= CHECK_INTERVAL_MS;
}

/**
 * 把 GitHub 的响应读成结论。
 *
 * 读不懂就当作「查不到」而不是「已是最新」：后者是个会误导人的断言，
 * 而我们此刻其实什么都不知道。
 */
export function readLatest(payload: unknown, current: string): UpdateInfo {
  const release = payload as { tag_name?: unknown; html_url?: unknown } | null;
  const tag = typeof release?.tag_name === "string" ? release.tag_name.trim() : "";
  if (!tag || !/\d/.test(tag)) return { latest: null, newer: false };
  const url = typeof release?.html_url === "string" ? release.html_url : undefined;
  return { latest: tag.replace(/^v/i, ""), newer: compareVersions(current, tag) < 0, url };
}

/**
 * 查一次。**任何失败都只是「查不到」**，不是错误状态。
 *
 * 离线、公司代理、GitHub 在某些网络下不可达 —— 这些都不是用户做错了什么，
 * 界面上不该出现一条像 bug 的报错。
 */
export async function checkForUpdate(current: string,
                                     fetchImpl: typeof fetch = fetch): Promise<UpdateInfo> {
  // 🔴 **不知道自己是哪一版就别比。** 空版本号比任何版本都「旧」，于是每次检查都会谎报
  // 「有新版本」。读不到自己的版本号不是不可能的事（资源目录读不到、命令没注册），
  // 而那时候正确的回答是「查不到」，不是编一个结论出来 —— 顺带也省掉一次没意义的请求。
  if (!current.trim()) return { latest: null, newer: false };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(RELEASES_API, {
      signal: abort.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return { latest: null, newer: false };
    return readLatest(await response.json(), current);
  } catch {
    return { latest: null, newer: false };
  } finally {
    clearTimeout(timer);
  }
}
