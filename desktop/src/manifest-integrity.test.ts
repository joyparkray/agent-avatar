import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadManifest, synthesizeManifest } from "./manifest";
import { parseInventory } from "./inventory";
import { parseModelIndex } from "./inventory";
import { REQUIRED_MOTION_STATES, resolveForState, resolveSemanticMotion, SEMANTIC_STATES } from "./types";

// v0.1 不随包分发第三方模型；开发者本地有 models/ 时仍校验其完整性，fresh clone 则为空集。
const shipped = existsSync("models/index.json")
  ? parseModelIndex(JSON.parse(readFileSync("models/index.json", "utf8")))
  : [];

describe("shipped avatar manifests", () => {
  it("lists every model directory that ships an avatar.json", () => {
    const dirs = (existsSync("models") ? readdirSync("models", { withFileTypes: true }) : [])
      .filter(entry => entry.isDirectory() && readdirSync(`models/${entry.name}`).includes("avatar.json"))
      .map(entry => entry.name).sort();
    expect(shipped.map(entry => entry.dir).sort()).toEqual(dirs);
  });

  // 回归：Haru 曾把 working/error 指到 TapBody 9/7，而该组只有 4 个动作，两个语义状态因此从不播放。
  // 逐态配置**不是必须**的（awaiting/reviewing 可共用 syncing 的动作，见 STATE_FALLBACK），
  // 但每个基态都必须能经回落链解析到一个真实存在的动作 —— 否则该状态在这个模型上从不播放。
  it.each(shipped)("$dir resolves every semantic state to a motion that exists", ({ dir }) => {
    const manifest = JSON.parse(readFileSync(`models/${dir}/avatar.json`, "utf8"));
    const inventory = parseInventory(JSON.parse(readFileSync(`models/${dir}/${manifest.model}`, "utf8")));
    for (const state of SEMANTIC_STATES) {
      expect(resolveForState(manifest.motions, state), `${dir}.${state} → 回落链走到头也没有动作`).toBeDefined();
    }
    for (const [state, [group, index]] of Object.entries(manifest.motions) as [string, [string, number]][]) {
      expect(SEMANTIC_STATES, `${dir} → 未知基态 "${state}"`).toContain(state);
      const found = inventory.motions.find(motion => motion.group === group);
      expect(found, `${dir}.${state} → unknown motion group "${group}"`).toBeDefined();
      expect(index, `${dir}.${state} → ${group}[${index}] out of range (0..${found!.count - 1})`).toBeLessThan(found!.count);
    }
    for (const name of Object.values(manifest.expressions ?? {}) as string[]) {
      expect(inventory.expressions, `${dir} → unknown expression "${name}"`).toContain(name);
    }
    for (const name of Object.values(manifest.reactions ?? {}) as string[]) {
      expect(inventory.expressions, `${dir} → unknown reaction expression "${name}"`).toContain(name);
    }
  });
});

describe("state fallback chain", () => {
  // syncing 拆成 awaiting/reviewing/syncing 后，既有 manifest 一行没改就该继续可用。
  const motions = { idle: ["Idle", 0], syncing: ["Flick", 0] } as const;
  it.each(["awaiting", "reviewing"] as const)("%s falls back to the syncing motion", state => {
    expect(resolveForState(motions as never, state)).toEqual(["Flick", 0]);
  });
  it("does not let a new state resolve when its fallback target is missing", () => {
    // 老的六个态仍必填：回落只覆盖新增态，不给 manifest 漏配老态开后门。
    expect(resolveForState({ idle: ["Idle", 0] } as never, "awaiting")).toBeUndefined();
  });
  it("prefers an explicit entry over the fallback", () => {
    expect(resolveForState({ ...motions, awaiting: ["Wait", 1] } as never, "awaiting")).toEqual(["Wait", 1]);
  });
  it("covers every semantic state once the required ones are configured", () => {
    const complete = Object.fromEntries(REQUIRED_MOTION_STATES.map(state => [state, ["Idle", 0]]));
    for (const state of SEMANTIC_STATES) expect(resolveForState(complete as never, state)).toBeDefined();
  });
});

describe("user state motion overrides", () => {
  it("overrides one state without replacing model defaults for the others", () => {
    const defaults = { idle: ["Idle", 0], syncing: ["Sync", 0] } as const;
    expect(resolveSemanticMotion({ awaiting: ["Wait", 1] }, defaults as never, "awaiting")).toEqual(["Wait", 1]);
    expect(resolveSemanticMotion({ awaiting: ["Wait", 1] }, defaults as never, "reviewing")).toEqual(["Sync", 0]);
  });
});

describe("manifest synthesis from the official model3.json", () => {
  // 官方 model3.json 已声明口型参数（Groups[LipSync]）与眨眼参数，库/SDK 直接读。
  // avatar.json 只补官方给不了的那一样：语义态 → 动作。没有它时按 Idle 合成即可。
  const withIdle = { motions: [{ group: "Tap", count: 3 }, { group: "Idle", count: 2 }], expressions: [] };

  it("points every required state at the Idle group", () => {
    const manifest = synthesizeManifest("haru", "Haru.model3.json", withIdle);
    for (const state of SEMANTIC_STATES) expect(resolveForState(manifest.motions, state)).toEqual(["Idle", 0]);
    expect(manifest.model).toBe("Haru.model3.json");
    expect(manifest.expressions).toBeUndefined();  // 没有表情是正常的（Hiyori 就没有）
  });

  it("falls back to the first group when the model has no Idle", () => {
    const manifest = synthesizeManifest("x", "x.model3.json", { motions: [{ group: "Flick", count: 1 }], expressions: [] });
    expect(resolveForState(manifest.motions, "idle")).toEqual(["Flick", 0]);
  });

  it("refuses a model with no motions at all", () => {
    expect(() => synthesizeManifest("x", "x.model3.json", { motions: [], expressions: [] })).toThrow("no motions");
  });

  it("loads a model that ships no avatar.json", async () => {
    const model3 = { FileReferences: { Motions: { Idle: [{}, {}] } }, Groups: [{ Target: "Parameter", Name: "LipSync", Ids: ["ParamMouthOpenY"] }] };
    const fetcher = (async () => ({ ok: true, json: async () => model3 })) as unknown as typeof fetch;
    const manifest = await loadManifest({ baseUrl: "/user-models/mine", model3: "mine.model3.json" }, fetcher);
    expect(manifest.model).toBe("mine.model3.json");
    expect(resolveForState(manifest.motions, "awaiting")).toEqual(["Idle", 0]);
  });

  it("still rejects a declared manifest that points at a motion the model lacks", async () => {
    // 回归：Haru 曾把状态指到不存在的动作序号，那些状态从不播放。合成路径放宽了，这条不能松。
    const declared = { id: "x", version: "1", cubismVersion: 4, model: "x.model3.json", motions: Object.fromEntries(REQUIRED_MOTION_STATES.map(s => [s, ["Idle", 9]])) };
    const fetcher = (async (url: string) => ({ ok: true, json: async () => String(url).endsWith("avatar.json") ? declared : { FileReferences: { Motions: { Idle: [{}] } } } })) as unknown as typeof fetch;
    await expect(loadManifest({ baseUrl: "/models/x", manifest: "avatar.json" }, fetcher)).rejects.toThrow("unknown avatar motion");
  });
});
