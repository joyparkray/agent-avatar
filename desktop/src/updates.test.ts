import { describe, expect, it } from "vitest";
import { checkForUpdate, CHECK_INTERVAL_MS, compareVersions, readLatest, RELEASES_API, shouldCheck } from "./updates";

describe("update check", () => {
  it("compares versions by number, not by string", () => {
    // "1.10.0" < "1.9.0" 按字符串比是对的，按版本比是错的 —— 而这里错了的后果是
    // 用户永远看不到更新，或者被告知一个更旧的版本才是最新的
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    // 发布标签常带 v 前缀
    expect(compareVersions("1.0.0", "v1.0.1")).toBeLessThan(0);
    // 段数不同也要能比
    expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
    // 读不出数字的段按 0 算，不能抛
    expect(compareVersions("1.0.0-rc1", "1.0.0")).toBe(0);
  });

  it("never goes online when the user turned it off", () => {
    // 🔴 关掉开关就是「不要联网」。这一条没有例外 —— 有例外的话，
    // 那个开关就成了摆设，而用户是认真的。
    expect(shouldCheck(false, null)).toBe(false);
    expect(shouldCheck(false, 0)).toBe(false);
  });

  it("checks once a day, and still works when the clock moves", () => {
    const now = 1_700_000_000_000;
    expect(shouldCheck(true, null, now)).toBe(true);            // 从没查过
    expect(shouldCheck(true, now - 1000, now)).toBe(false);     // 刚查过
    expect(shouldCheck(true, now - CHECK_INTERVAL_MS, now)).toBe(true);
    // 系统时间被往回调过（或跨时区）时上次检查会变成「未来」—— 不能因此永远不再查
    expect(shouldCheck(true, now + CHECK_INTERVAL_MS * 2, now)).toBe(true);
  });

  it("treats an unreadable answer as \"don't know\", not as \"up to date\"", () => {
    // 说「已是最新」是一个断言，而这时候我们其实什么都不知道 —— 那会让一个
    // 真的有新版本的用户以为自己已经是最新的
    expect(readLatest(null, "1.0.0")).toEqual({ latest: null, newer: false });
    expect(readLatest({}, "1.0.0")).toEqual({ latest: null, newer: false });
    expect(readLatest({ tag_name: "" }, "1.0.0")).toEqual({ latest: null, newer: false });
    expect(readLatest({ tag_name: "nightly" }, "1.0.0")).toEqual({ latest: null, newer: false });
  });

  it("reads a release into a verdict", () => {
    const release = { tag_name: "v1.2.0", html_url: "https://example.invalid/releases/v1.2.0" };
    expect(readLatest(release, "1.0.0")).toEqual({
      latest: "1.2.0", newer: true, url: release.html_url,
    });
    // 用户装的比发布的还新（自己构建的）时不该被催着「更新」到一个更旧的版本
    expect(readLatest(release, "1.3.0").newer).toBe(false);
    expect(readLatest(release, "1.2.0").newer).toBe(false);
  });

  it("turns every network failure into a quiet \"don't know\"", async () => {
    // 离线、代理、GitHub 在某些网络下不可达 —— 都不是用户做错了什么，
    // 界面上不该出现一条像 bug 的报错
    const dead = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));
    await expect(checkForUpdate("1.0.0", dead as unknown as typeof fetch))
      .resolves.toEqual({ latest: null, newer: false });

    const rateLimited = () => Promise.resolve({ ok: false, status: 403 } as Response);
    await expect(checkForUpdate("1.0.0", rateLimited as unknown as typeof fetch))
      .resolves.toEqual({ latest: null, newer: false });

    const garbage = () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error("not json")) } as unknown as Response);
    await expect(checkForUpdate("1.0.0", garbage as unknown as typeof fetch))
      .resolves.toEqual({ latest: null, newer: false });
  });

  it("does not compare against a version it does not know", async () => {
    // 空版本号比任何版本都「旧」，于是每次检查都会谎报「有新版本」。读不到自己的版本号
    // 不是不可能的事，而那时候正确的回答是「查不到」，不是编一个结论出来。
    let called = false;
    const spy = (() => { called = true; return Promise.resolve({ ok: true, json: () => Promise.resolve({ tag_name: "v9.9.9" }) } as unknown as Response); }) as unknown as typeof fetch;
    await expect(checkForUpdate("", spy)).resolves.toEqual({ latest: null, newer: false });
    await expect(checkForUpdate("  ", spy)).resolves.toEqual({ latest: null, newer: false });
    expect(called, "不知道自己版本时连请求都不该发").toBe(false);
  });

  it("asks the release API of the repo this app is published from", async () => {
    let asked = "";
    const spy = ((url: string) => {
      asked = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ tag_name: "v1.1.0" }) } as unknown as Response);
    }) as unknown as typeof fetch;
    const info = await checkForUpdate("1.0.0", spy);
    expect(asked).toBe(RELEASES_API);
    expect(RELEASES_API).toContain("joyparkray/agent-avatar");
    expect(info.newer).toBe(true);
  });
});
