export interface ModelInventory { motions: { group: string; count: number; files?: string[] }[]; expressions: string[] }
export interface ModelEntry { dir: string; label: string }

/** 从 Cubism `model3.json` 读出可播放的动作组与表情。菜单据此现场生成，换模型即变。 */
export function parseInventory(model3: unknown): ModelInventory {
  const refs = (model3 as { FileReferences?: Record<string, unknown> } | null)?.FileReferences ?? {};
  const motionMap = (refs.Motions ?? {}) as Record<string, unknown[]>;
  const motions = Object.entries(motionMap)
    .filter(([, list]) => Array.isArray(list) && list.length > 0)
    // 顺带记下每条动作的文件名：官方模型允许**组名为空**（haru_greeter 的 27 个动作全在 "" 组里），
    // 那时序号是界面上唯一能区分它们的东西，而文件名（haru_g_m01）才是作者起的名字。
    .map(([group, list]) => ({
      group, count: list.length,
      files: list.map(item => motionFileName((item as { File?: unknown })?.File)),
    }));
  const expressionList = (refs.Expressions ?? []) as { Name?: string }[];
  const expressions = Array.isArray(expressionList)
    ? expressionList.map(item => item?.Name).filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  return { motions, expressions };
}

export function parseModelIndex(value: unknown): ModelEntry[] {
  const list = (value as { models?: unknown[] } | null)?.models;
  if (!Array.isArray(list)) return [];
  return list
    .map(item => item as Partial<ModelEntry>)
    .filter((item): item is ModelEntry => typeof item?.dir === "string" && typeof item?.label === "string");
}

export async function loadInventory(baseUrl: string, model3File: string, fetcher: typeof fetch = fetch): Promise<ModelInventory> {
  const response = await fetcher(`${baseUrl}/${model3File}`);
  if (!response.ok) throw new Error(`model3 HTTP ${response.status}`);
  return parseInventory(await response.json());
}

export async function loadModelIndex(fetcher: typeof fetch = fetch): Promise<ModelEntry[]> {
  const response = await fetcher("/models/index.json");
  if (!response.ok) return [];
  return parseModelIndex(await response.json());
}

export type MotionRef = [group: string, index: number];

export function motionRefs(inventory: ModelInventory): MotionRef[] {
  return inventory.motions.flatMap(({ group, count }) =>
    Array.from({ length: count }, (_, index): MotionRef => [group, index]));
}

export function motionKey([group, index]: MotionRef): string { return `${group}:${index}`; }

/** `motion/haru_g_m01.motion3.json` → `haru_g_m01`。取不到就给空串，由 motionLabel 兜底。 */
function motionFileName(file: unknown): string {
  if (typeof file !== "string") return "";
  return file.split("/").pop()?.replace(/\.motion3\.json$/i, "") ?? "";
}

/** 组名为空的模型（haru_greeter）不能显示成 `" 0"`：优先用文件名，再退到序号。 */
export function motionLabel(inventory: ModelInventory, [group, index]: MotionRef): string {
  const file = inventory.motions.find(item => item.group === group)?.files?.[index];
  if (group) return `${group} ${index}`;
  return file || `#${index}`;
}

/** 二级菜单的组标题。空组名在菜单里是一条读不出名字的项。 */
export const motionGroupLabel = (group: string, english = false): string =>
  group || (english ? "(unnamed)" : "（未命名）");

/** 默认放进随机名单的动作：除 Idle 外的全部。Idle 是常驻环境动作，当作「回应」不合适。 */
export function defaultEnabledMotions(inventory: ModelInventory): string[] {
  const refs = motionRefs(inventory);
  const reactions = refs.filter(([group]) => group.toLowerCase() !== "idle");
  return (reactions.length ? reactions : refs).map(motionKey);
}

/**
 * 双击时从随机名单里挑一个。名单为空表示用户全关了，双击不做任何事。
 * 名单里只留一个，双击就等于固定播那个动作。
 */
export function pickEnabledMotion(
  inventory: ModelInventory, enabled: readonly string[], random: () => number = Math.random,
): MotionRef | undefined {
  const pool = motionRefs(inventory).filter(ref => enabled.includes(motionKey(ref)));
  if (!pool.length) return undefined;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

/** 默认放进随机名单的表情：全部。 */
export function defaultEnabledExpressions(inventory: ModelInventory): string[] {
  return [...inventory.expressions];
}

/**
 * 单击触发哪个表情。只从随机名单里挑，并尽量不重复上一次。
 * 名单为空或模型本就没有表情（Hiyori 即如此）时返回 undefined，单击安静地什么都不做。
 */
export function pickEnabledExpression(
  inventory: ModelInventory, enabled: readonly string[], previous: string | null, random: () => number = Math.random,
): string | undefined {
  const pool = inventory.expressions.filter(name => enabled.includes(name));
  if (!pool.length) return undefined;
  const fresh = pool.filter(name => name !== previous);
  const list = fresh.length ? fresh : pool;
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}
