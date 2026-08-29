/**
 * DeepSeek Harness 适配层 —— cordis 插件（in-process）。
 *
 * dsh **不是** Claude Code 系：事件名、载荷、注册方式全不同（`core/pascal_events.py`
 * 那张表在这里用不上）。它的事件是 cordis 事件，语义流全在 `session/event` 里。
 *
 * 🔴 **只订阅 `@mode emit` 的事件**（.d.ts 里有标注）。dsh 的 `tools/pre-execute` /
 * `tools/execute` / `agent/pre-step` 是 **waterfall**、`agent/turn-stopping` 是
 * **serial** —— 那些在决策链路上，监听器的返回值会改变 harness 行为。观察者绝不进去
 * （BRIDGE-PROTOCOL §7.2）。emit 是纯通知，返回值不参与任何判定。
 *
 * 事件翻译在这里做，**状态机仍然只有一份**（`state_machine.py`）：本插件把内部词表的
 * payload 喂给同级的 `agent-avatar-hook.py`。为此每个事件起一个 python 子进程 ——
 * 与 CC / Codex 的 shell hook 是同一个量级（一个回合 6~10 条），
 * 但**必须串行**：并发子进程会让 pre_tool_call / post_tool_call 乱序到达状态机。
 *
 * 实机抓取（2026-08-28，dsh 0.1.1-rc.2 headless + `sleep 4`）确认的时序：
 *   session/created → turn/start(turn=1) → step/start → tool/call(callId,name)
 *   → tool/result(message.source.callId, content[].isError) → step/end
 *   → step/start → step/end → turn/end(reason.kind)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const name = "agent-avatar";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "agent-avatar-hook.py");

/** 串行队列：保证事件按发生顺序抵达状态机。永不 reject，观察者不该产生未处理拒绝。 */
let queue = Promise.resolve();

function emit(payload) {
  queue = queue.then(() => new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const child = spawn("python3", [HOOK], { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", finish);      // python3 不存在等：静默放弃这一条
      child.on("close", finish);
      child.stdin.on("error", finish);  // 子进程先退出会让写 stdin 报 EPIPE
      child.stdin.end(JSON.stringify(payload));
    } catch { finish(); }
  })).catch(() => {});
  return queue;
}

/** 子代理的会话 id：它们的事件不该驱动形象（子代理报错时父会话好好的）。 */
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
        return void emit({ hook_event_name: "pre_tool_call", session_id: id, turn_id: String(data.turn),
                          tool_use_id: data.callId, tool_name: data.name });
      case "tool/result": {
        // 配对键在 message.source.callId（tool/result 的 data 顶层没有 callId —— 实机确认）
        const message = data.message ?? {};
        const failed = (message.content ?? []).some(part => part?.isError);
        return void emit({ hook_event_name: "post_tool_call", session_id: id, turn_id: String(data.turn),
                           tool_use_id: message.source?.callId, status: failed ? "error" : "ok" });
      }
      default:
        return;   // assistant/chunk 等一律忽略（一轮几十条，且不含状态信息）
    }
  });

  /**
   * 子代理：**只用来把它的会话挡在门外，不做 awaiting 记账**。两条实测理由：
   *
   * 1. `subagent/start` 的监听器**只收到一个实参**（`info`），拿不到发起方。
   *    `.d.ts` 里 LifecycleEmitter 写的是 `(name, info, parent)`，但那个 `parent` 是
   *    scope carrier，不会传给监听器 —— 照文档写的话 `session_id` 是 undefined，
   *    记账会落到子代理自己头上（实机撞到：子会话的 subagents 里装着它自己，
   *    phase 永远停在 writing）。
   * 2. dsh 的子代理是**后台 job**：父会话答完 `done` 收工时，`subagent/end` 还没来
   *    （实测两轮都没等到）。按 start/stop 配对记 awaiting，形象会永远卡在那个状态。
   *
   * 父会话的状态本来就是准的 —— 它自己在 `tool/call`（含 `subagent`、`job_output`
   * 这些）之间来回，writing / executing 如实反映。
   */
  ctx.on("subagent/start", info => {
    if (!info?.id) return;
    childSessions.add(info.id);
    // 子代理的 session/created 可能**早于**这条通知，那就已经建了一条会话记账；
    // 用 finalize 把它清掉，否则它会一直挂在那里参与「谁最近活动」的竞争。
    emit({ hook_event_name: "on_session_finalize", session_id: info.id });
  });
  // 结束通知不一定来得及；来了也只是再确认一次清理。**不从忽略名单里删** ——
  // 后台 job 在父会话之后还会继续发事件，那些照样不该驱动形象。
  ctx.on("subagent/end", info => {
    if (info?.id) emit({ hook_event_name: "on_session_finalize", session_id: info.id });
  });
}
