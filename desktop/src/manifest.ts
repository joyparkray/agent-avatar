import type { AvatarManifest, AvatarSource, SemanticState } from "./types";
import { REACTIONS, REQUIRED_MOTION_STATES, SEMANTIC_STATES, resolveForState } from "./types";
import { parseInventory, type ModelInventory } from "./inventory";

/**
 * 没有 `avatar.json` 时按官方信息合成一份清单。
 *
 * 官方 `model3.json` 已经声明了口型参数（`Groups[LipSync]`）与眨眼参数（`Groups[EyeBlink]`），
 * 库和 SDK 直接读，不需要我们转述。这里只补官方给不了的那一样：语义态 → 动作的映射。
 * 全部指向 `Idle` 组 —— 两个官方示例模型都有它，是 Cubism 的通行惯例；没有 Idle 就用
 * 第一个可用组。表情留空（Hiyori 这类模型本来就没有表情，属正常）。
 */
export function synthesizeManifest(id: string, model3: string, inventory: ModelInventory): AvatarManifest {
  const group = inventory.motions.find(motion => motion.group.toLowerCase() === "idle") ?? inventory.motions[0];
  if (!group) throw new Error("model3 has no motions");
  const motions = Object.fromEntries(REQUIRED_MOTION_STATES.map(state => [state, [group.group, 0]]));
  return { id, version: "0", cubismVersion: 4, model: model3, motions } as AvatarManifest;
}

async function fetchJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** avatar.json 是可选的：取不到就当没有，用官方 model3.json 合成。 */
async function readDeclared(source: AvatarSource, fetcher: typeof fetch): Promise<Partial<AvatarManifest> | null> {
  if (!source.manifest) return null;
  try {
    return await fetchJson(`${source.baseUrl}/${source.manifest}`, fetcher) as Partial<AvatarManifest>;
  } catch {
    return null;
  }
}

function validate(value: Partial<AvatarManifest>): AvatarManifest {
  if (!value.id || value.cubismVersion !== 4 || !value.model || !value.motions) throw new Error("invalid avatar manifest");
  // 每个基态**经回落链**能解析到一个合法动作即可 —— 不要求逐态配置（见 STATE_FALLBACK）。
  for (const [key, motion] of Object.entries(value.motions)) {
    if (!(SEMANTIC_STATES as readonly string[]).includes(key)) throw new Error(`unknown avatar motion: ${key}`);
    if (!Array.isArray(motion) || motion.length !== 2 || typeof motion[0] !== "string" || !motion[0] || !Number.isSafeInteger(motion[1]) || motion[1] < 0) throw new Error(`invalid avatar motion: ${key}`);
  }
  for (const state of SEMANTIC_STATES) {
    if (!resolveForState(value.motions, state)) throw new Error(`missing avatar motion: ${state}`);
  }
  const expressionKeys = SEMANTIC_STATES.filter(state => state !== "idle");
  for (const [key, name] of Object.entries(value.expressions ?? {})) if (!expressionKeys.includes(key as never) || typeof name !== "string" || !name) throw new Error(`invalid avatar expression: ${key}`);
  for (const [key, name] of Object.entries(value.reactions ?? {})) if (!(REACTIONS as readonly string[]).includes(key) || typeof name !== "string" || !name) throw new Error(`invalid avatar reaction: ${key}`);
  return value as AvatarManifest;
}

export async function loadManifest(source: AvatarSource, fetcher: typeof fetch = fetch): Promise<AvatarManifest> {
  const declared = await readDeclared(source, fetcher);
  const model3File = declared?.model ?? source.model3;
  if (!model3File) throw new Error("invalid avatar manifest");
  const inventory = parseInventory(await fetchJson(`${source.baseUrl}/${model3File}`, fetcher));
  const manifest = declared ? validate(declared) : synthesizeManifest(source.baseUrl.split("/").pop() || "model", model3File, inventory);

  // 声明的动作/表情必须真实存在 —— Haru 曾把两个状态指到不存在的动作序号，那两个状态从不播放。
  for (const state of SEMANTIC_STATES) {
    const [group, index] = resolveForState(manifest.motions, state) as [string, number];
    const found = inventory.motions.find(item => item.group === group);
    if (!found || index >= found.count) throw new Error(`unknown avatar motion: ${state}`);
  }
  for (const name of [...Object.values(manifest.expressions ?? {}), ...Object.values(manifest.reactions ?? {})]) {
    if (!inventory.expressions.includes(name!)) throw new Error(`unknown avatar expression: ${name}`);
  }
  return manifest;
}

export type { SemanticState };
