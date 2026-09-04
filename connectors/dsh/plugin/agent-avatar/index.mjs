/**
 * DeepSeek Harness adapter — cordis plugin (in-process).
 *
 * dsh is **not** part of the Claude Code family: event names, payloads and the
 * registration model all differ (the table in `core/pascal_events.py` is of no
 * use here). Its events are cordis events, and the whole semantic stream arrives
 * inside `session/event`.
 *
 * 🔴 **Only subscribe to `@mode emit` events** (they are annotated in the .d.ts).
 * dsh's `tools/pre-execute`, `tools/execute` and `agent/pre-step` are
 * **waterfall**, and `agent/turn-stopping` is **serial** — those sit in the
 * decision path, where a listener's return value changes what the harness does.
 * An observer never goes there (BRIDGE-PROTOCOL §7.2). `emit` events are pure
 * notifications: the return value takes part in no decision.
 *
 * Event translation happens here, and **there is still exactly one state
 * machine** (`state_machine.py`): this plugin feeds internal-vocabulary payloads
 * to the sibling `agent-avatar-hook.py`. That means one python subprocess per
 * event — the same order of magnitude as the shell hooks in Claude Code and Codex
 * (6–10 per turn) — but they **must be serialised**: concurrent subprocesses would
 * let pre_tool_call and post_tool_call reach the state machine out of order.
 *
 * Timing confirmed by capture on real hardware (2026-08-28, dsh 0.1.1-rc.2
 * headless running `sleep 4`):
 *   session/created → turn/start(turn=1) → step/start → tool/call(callId,name)
 *   → tool/result(message.source.callId, content[].isError) → step/end
 *   → step/start → step/end → turn/end(reason.kind)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const name = "agent-avatar";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "agent-avatar-hook.py");

/**
 * The interpreter. **The installer rewrites the default on the line below to an
 * absolute path that was verified to work on this machine.** On Windows,
 * `python3` resolves to a 0-byte Microsoft Store stub: it starts, prints "Python
 * was not found" and exits with 9009 — and since stderr is `ignore`d below and the
 * `error` event only fires when the spawn itself fails, that failure mode makes
 * **no sound at all**. The environment variable wins, so a user can point at a
 * different interpreter without reinstalling.
 */
const PYTHON = process.env.AGENT_AVATAR_PYTHON || "python3";

/** Serial queue: events reach the state machine in the order they happened.
 *  Never rejects — an observer must not produce unhandled rejections. */
let queue = Promise.resolve();

/** dsh 的工具参数是个 JSON 字符串；对象也接受，坏了就当没有。 */
function toolInput(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function emit(payload) {
  queue = queue.then(() => new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const child = spawn(PYTHON, [HOOK], { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", finish);        // no such interpreter, etc.: drop this event quietly
      child.on("close", finish);
      child.stdin.on("error", finish);  // a child that exits first makes the stdin write EPIPE
      child.stdin.end(JSON.stringify(payload));
    } catch { finish(); }
  })).catch(() => {});
  return queue;
}

/** Subagent session ids: their events must not drive the avatar (when a subagent
 *  errors, the parent session is perfectly fine). */
const childSessions = new Set();

export function apply(ctx) {
  ctx.on("session/created", session => {
    if (childSessions.has(session?.id)) return;
    emit({ hook_event_name: "on_session_start", session_id: session?.id });
  });

  ctx.on("session/disposed", session => {
    childSessions.delete(session?.id);
    emit({ hook_event_name: "on_session_finalize", session_id: session?.id });
  });

  ctx.on("session/event", (session, event) => {
    const id = session?.id;
    if (!id || childSessions.has(id)) return;
    const data = event?.data ?? {};
    switch (event?.type) {
      case "turn/start":
        return void emit({ hook_event_name: "pre_llm_call", session_id: id, turn_id: String(data.turn) });
      case "turn/end":
        return void emit({ hook_event_name: "post_llm_call", session_id: id, turn_id: String(data.turn) });
      case "tool/call":
        // 🔴 `arguments` 要带上，否则状态栏第二行（「它具体在做什么」）对 dsh **永远是空的**
        // —— 状态机拿 `tool_input` 里的 description/path/query 那几个字段拼那一行，没有
        // 输入就没有可拼的东西。实机 2026-09-03：dsh 只报得出一级状态。
        // 出处是 dsh 自己的 agent 循环（`@deepseek-ai/dsh-agent-loop/lib/index.js`）：
        //     "tool/call", { turn, step, callId: block.id, name: block.name,
        //                    arguments: block.arguments }
        // `block.arguments` 按 LLM tool-call 的惯例是 **JSON 字符串**，所以要先解析；
        // `toolInput` 对字符串和对象都收，解析不了就不带 —— 少一行详情，
        // 不能因此丢掉整个事件。
        return void emit({ hook_event_name: "pre_tool_call", session_id: id, turn_id: String(data.turn),
                          tool_use_id: data.callId, tool_name: data.name,
                          tool_input: toolInput(data.arguments) });
      case "tool/result": {
        // The pairing key lives in message.source.callId — tool/result has no
        // callId at the top level of data (confirmed on real hardware).
        const message = data.message ?? {};
        const failed = (message.content ?? []).some(part => part?.isError);
        return void emit({ hook_event_name: "post_tool_call", session_id: id, turn_id: String(data.turn),
                           tool_use_id: message.source?.callId, status: failed ? "error" : "ok" });
      }
      default:
        return;   // ignore assistant/chunk and friends (dozens per turn, no state in them)
    }
  });

  /**
   * Subagents: **used only to keep their sessions out, never to account for an
   * "awaiting" state.** Two measured reasons:
   *
   * 1. The `subagent/start` listener **receives a single argument** (`info`) and
   *    cannot see who started it. The .d.ts declares LifecycleEmitter as
   *    `(name, info, parent)`, but that `parent` is a scope carrier and is not
   *    passed to listeners — following the docs gives you an undefined
   *    `session_id`, and the bookkeeping lands on the subagent itself (seen on
   *    real hardware: the child session's `subagents` contained itself and its
   *    phase never left `writing`).
   * 2. dsh subagents are **background jobs**: when the parent session finishes and
   *    reports `done`, `subagent/end` has not arrived yet (never did, across two
   *    runs). Pairing start/stop into an `awaiting` state would leave the avatar
   *    stuck there forever.
   *
   * The parent session's own state is already accurate — it moves between
   * `tool/call` events (including `subagent` and `job_output`), so writing and
   * executing reflect reality.
   */
  ctx.on("subagent/start", info => {
    if (!info?.id) return;
    childSessions.add(info.id);
    // The subagent's session/created may arrive **before** this notification, in
    // which case a session record already exists; finalize clears it, otherwise it
    // lingers and competes in "who was active most recently".
    emit({ hook_event_name: "on_session_finalize", session_id: info.id });
  });
  // The end notification may never arrive in time; when it does, it just confirms
  // the cleanup. **Do not remove the id from the ignore set** — background jobs keep
  // emitting events after the parent session is done, and those must not drive the
  // avatar either.
  ctx.on("subagent/end", info => {
    if (info?.id) emit({ hook_event_name: "on_session_finalize", session_id: info.id });
  });
}
