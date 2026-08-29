/**
 * DeepSeek Harness 取样器 —— 把 emit 类事件的载荷形状记成 jsonl。
 *
 * 接一家新 harness 的第一步（BRIDGE-PROTOCOL §6.1）：先实抓一轮，再写代码。
 *
 * 🔴 **只订阅 `@mode emit` 的事件**。dsh 的 `tools/pre-execute` / `tools/execute` /
 * `agent/pre-step` 是 **waterfall**，`agent/turn-stopping` 是 **serial** —— 那些在决策
 * 链路上，观察者绝不能进去（§7.2）。emit 是纯通知，监听器的返回值不参与任何判定。
 *
 * 用法：
 *   dsh --profile headless --patch <patch.yml> "跑一个 sleep 4 的命令"
 * 输出：$AGENT_AVATAR_SAMPLE（默认 /tmp/agent-avatar-dsh-sample.jsonl）
 */
import { appendFileSync } from "node:fs";

export const name = "agent-avatar-sample";

/** 只有这些是 emit（纯通知）。改这张表前先核对 .d.ts 里的 `@mode`。 */
const EMIT_EVENTS = [
  "session/created", "session/disposed", "session/event",
  "agent/created", "agent/disposed", "agent/session-start", "agent/status", "agent/error",
  "agent/inbox/inserted", "agent/inbox/claimed", "agent/inbox/discarded",
  "tools/result", "tools/change",
  "subagent/start", "subagent/end",
];

/** 载荷里全是活对象（Agent / Session）。只取浅层可读字段，别把整棵图序列化进去。 */
function summarize(value, depth = 0) {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" && value.length > 200 ? value.slice(0, 200) + "…" : value;
  }
  if (Array.isArray(value)) return depth >= 1 ? `[${value.length} items]` : value.slice(0, 4).map(item => summarize(item, depth + 1));
  if (depth >= 2) return `{${Object.keys(value).slice(0, 12).join(",")}}`;
  const out = {};
  for (const key of Object.keys(value).slice(0, 24)) {
    try { out[key] = summarize(value[key], depth + 1); } catch { out[key] = "<throws>"; }
  }
  // 类实例的字段多在原型的 getter 上，Object.keys 看不见 —— 单独把常用的几个捞出来
  for (const key of ["id", "status", "name", "turn", "kind", "type", "label"]) {
    if (!(key in out)) { try { if (value[key] !== undefined) out[key] = summarize(value[key], depth + 1); } catch { /* getter 抛错就算了 */ } }
  }
  return out;
}

export function apply(ctx) {
  const sink = process.env.AGENT_AVATAR_SAMPLE || "/tmp/agent-avatar-dsh-sample.jsonl";
  for (const event of EMIT_EVENTS) {
    try {
      // **记全部实参**：dsh 的事件不都是单个 payload 对象 ——
      // `session/event(session, event)` 就是两个参数，只看第一个会把真正的事件整个漏掉。
      ctx.on(event, (...args) => {
        try {
          appendFileSync(sink, JSON.stringify({ _at: Date.now() / 1000, _event: event, args: args.map(arg => summarize(arg)) }) + "\n");
        } catch { /* 取样器绝不能把 harness 搞坏 */ }
      });
    } catch (error) {
      // 事件名不存在等：记一条就继续，别让取样器阻断启动
      try { appendFileSync(sink, JSON.stringify({ _event: event, _subscribe_failed: String(error) }) + "\n"); } catch { /* 略 */ }
    }
  }
}
