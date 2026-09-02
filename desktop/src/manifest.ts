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
 *
 * **一个动作都没有也是合法的**，不再拒绝。面捕向的模型（VTube Studio / VTuber 那一类）
 * 普遍只带表情、零动作 —— 它们的动作由摄像头实时驱动，作者没有理由再导出 `motion3.json`。
 * 这类模型在这里照样能起来：眨眼走 `Groups[EyeBlink]`、口型走 `Groups[LipSync]`、
 * 头发衣服走 `physics3.json`、视线由我们自己驱动，全都不经过动作系统。
 * 代价只是**八个状态之间没有动作差异**（可用 `avatar.json` 的 `expressions` 补上）。
 * 原来这里直接抛 `model3 has no motions`，用户看到的只是一句「模型加载失败」，
 * 而这类模型恰恰是网上最常见的一种。
 */
export function synthesizeManifest(id: string, model3: string, inventory: ModelInventory): AvatarManifest {
  const group = inventory.motions.find(motion => motion.group.toLowerCase() === "idle") ?? inventory.motions[0];
  const motions = group
    ? Object.fromEntries(REQUIRED_MOTION_STATES.map(state => [state, [group.group, 0]]))
    : {};
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
  // `motions` 允许缺省/为空 —— 无动作模型（见 synthesizeManifest）。但**一旦写了动作，
  // 就要求写全**：漏配的那个状态会静默地不播放，比整份拒绝更难查。
  if (!value.id || value.cubismVersion !== 4 || !value.model) throw new Error("invalid avatar manifest");
  const motions = value.motions ?? {};
  for (const [key, motion] of Object.entries(motions)) {
    if (!(SEMANTIC_STATES as readonly string[]).includes(key)) throw new Error(`unknown avatar motion: ${key}`);
    if (!Array.isArray(motion) || motion.length !== 2 || typeof motion[0] !== "string" || !motion[0] || !Number.isSafeInteger(motion[1]) || motion[1] < 0) throw new Error(`invalid avatar motion: ${key}`);
  }
  // 每个基态**经回落链**能解析到一个合法动作即可 —— 不要求逐态配置（见 STATE_FALLBACK）。
  if (Object.keys(motions).length > 0) {
    for (const state of SEMANTIC_STATES) {
      if (!resolveForState(motions, state)) throw new Error(`missing avatar motion: ${state}`);
    }
  }
  value.motions = motions;
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
  // 无动作模型跳过这一整段：没有动作可指，也就没有「指错」可言。
  if (Object.keys(manifest.motions).length > 0) {
    for (const state of SEMANTIC_STATES) {
      const [group, index] = resolveForState(manifest.motions, state) as [string, number];
      const found = inventory.motions.find(item => item.group === group);
      if (!found || index >= found.count) throw new Error(`unknown avatar motion: ${state}`);
    }
  }
  for (const name of [...Object.values(manifest.expressions ?? {}), ...Object.values(manifest.reactions ?? {})]) {
    if (!inventory.expressions.includes(name!)) throw new Error(`unknown avatar expression: ${name}`);
  }
  return manifest;
}

export type { SemanticState };
