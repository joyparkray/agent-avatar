#!/usr/bin/env python3
"""Claude Code 系事件词表的共用翻译层（stdlib only）。

**四家共用**：Claude Code、Codex、DeepSeek Harness、WorkBuddy。
它们的事件名、stdin 字段名、注册结构高度同构（`hook_event_name` / `session_id` /
`tool_use_id` / `agent_id` 都是公共字段），差异小到可以用一张配置表表达 ——
所以这里是一个翻译函数 + 每家一份配置，不是四份复制粘贴的脚本。

契约来源：各家官方文档 + 实机抓取（Claude Code 2.1.212 用隔离 --settings 取样器抓过
完整两轮，含子代理；见 docs/DESIGN-M3-MULTI-HARNESS.md §2.6/§2.8）。
"""

# 共用的事件映射。每家按自己支持的事件裁剪 —— 映射表里查不到就忽略，
# 所以「这家少发某个事件」不需要任何额外处理。
_BASE_EVENTS = {
    "UserPromptSubmit": "pre_llm_call",
    "PreToolUse": "pre_tool_call",
    "PostToolUse": "post_tool_call",
    "SubagentStart": "subagent_start",
    "SubagentStop": "subagent_stop",
    "Stop": "post_llm_call",
    "SessionEnd": "on_session_finalize",
}

CLAUDE_CODE = {
    "id": "claude-code",
    "label": "Claude Code",
    # 实测：同一轮内从 UserPromptSubmit 到 Stop 全程不变，下一轮换新值，session_id 不变。
    "turn_fields": ("prompt_id",),
    # 只有这两个 source 是「开新的一局」。resume/compact/fork 是同一局的延续 ——
    # 当成全量重置会清掉还活着的子代理和在跑的工具。
    "reset_sources": ("startup", "clear"),
    "events": dict(_BASE_EVENTS,
                   # CC 把工具失败做成独立事件，比从返回值反推更明确
                   PostToolUseFailure="post_tool_call",
                   # 被动的「已被拒」，不是阻塞式的 PermissionRequest
                   PermissionDenied="post_tool_call"),
}

CODEX = {
    "id": "codex",
    "label": "Codex",
    # Codex 直接给 turn_id（官方：turn-scoped hooks 都带）。
    "turn_fields": ("turn_id",),
    # 官方 source 只有 startup/resume/clear/compact，没有 CC 的 fork。
    "reset_sources": ("startup", "clear"),
    # 没有 PostToolUseFailure（错误从 tool_response 反推），
    # 没有 PermissionDenied（只有阻塞式的 PermissionRequest —— 绝不注册，见下）。
    "events": dict(_BASE_EVENTS),
}

# 🔴 **绝不映射、绝不注册**的事件，以及原因：
# - PermissionRequest：阻塞式决策 hook。CC 那边有过真实故障 —— 接收端不在时
#   直接拒绝工具调用而不是回落到确认框（anthropics/claude-code#46193）。
#   表情系统绝不进权限决策链路。
# - WorktreeCreate：要求往 stdout 打印新 worktree 路径，被动 hook 会让 `claude -w` 报错。
# - PreCompact / PostToolBatch / TaskCreated / ...：无新信息，白名单原则。
_NEVER = frozenset({"PermissionRequest", "WorktreeCreate", "PreCompact", "PostCompact",
                    "PostToolBatch", "TaskCreated", "TaskCompleted", "TeammateIdle",
                    "UserPromptExpansion", "ConfigChange", "Elicitation", "ElicitationResult"})


def translate(payload, harness):
    """harness 的 payload → 状态机 payload。返回 None 表示这条事件不该驱动形象。"""
    event = payload.get("hook_event_name")
    if event in _NEVER:
        return None

    # 子代理内部的事件带 agent_id，且带的是**父会话的** session_id（CC 实测确认，
    # Codex 官方字段相同）。放行会让子代理的一个工具报错把 Echo 顶成 error，
    # 而父会话其实好好的。SubagentStart/Stop 本身也带 agent_id，但那是父会话的记账。
    if payload.get("agent_id") and event not in ("SubagentStart", "SubagentStop"):
        return None

    if event == "SessionStart":
        if payload.get("source") not in harness["reset_sources"]:
            return None
        internal = "on_session_start"
    else:
        internal = harness["events"].get(event)
        if internal is None:
            return None

    # stop_hook_active = 这条 Stop 是别的 hook 阻止停止后的续跑，不是真的回合结束。
    # 当成回合结束会让形象闪一下 idle 再跳回去。
    if event in ("Stop", "SubagentStop") and payload.get("stop_hook_active") is True:
        if event == "Stop":
            return None

    out = {
        "hook_event_name": internal,
        "session_id": payload.get("session_id") or "",
        # 回合 id 的字段名各家不同（CC 是 prompt_id，Codex 是 turn_id）。按顺序取第一个有值的，
        # **一个都没有就退回 session_id**：WorkBuddy 两个字段都没有（实测 + 其 CLI 里
        # `prompt_id` / `turn_id` 字符串出现 0 次），而 turn_id 为空时状态机根本不记回合 ——
        # 表现是整轮没有 `writing`、工具之间闪回 idle（实测就是这样）。
        # 退回 session 是安全的：这些 harness 一个会话同一时刻只跑一个回合，
        # 回合边界由 UserPromptSubmit / Stop 给出，而它们本来就带 session_id。
        "turn_id": next((str(payload[key]) for key in harness["turn_fields"]
                         if payload.get(key)), "") or str(payload.get("session_id") or ""),
        "tool_name": payload.get("tool_name"),
        "tool_input": payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else None,
        "tool_use_id": payload.get("tool_use_id"),
    }

    # 子代理身份是 agent_id，不是 Hermes 的 child_session_id。转成状态机认识的键。
    if event in ("SubagentStart", "SubagentStop"):
        out["child_session_id"] = payload.get("agent_id")

    # Codex 没有 PostToolUseFailure，错误只能从工具返回值反推 —— 交给状态机的
    # has_error()（它会解析 result 里的 error / is_error / success / exit_code）。
    # CC 也带 tool_response，一并透传：即使用户漏注册了 PostToolUseFailure 也还有兜底。
    if "tool_response" in payload:
        out["result"] = payload["tool_response"]
    if event == "PostToolUseFailure":
        out["status"] = "error"
    # 被拒 = blocked 叠加反应（不改基态），与 Hermes 的 status="blocked" 同口径。
    if event == "PermissionDenied":
        out["status"] = "blocked"
    return out


# WorkBuddy 的 agent core 就是随 app 分发的 CodeBuddy Code CLI（实机 v2.115.0），
# hook 词表与 Claude Code **完全一致** —— 含 PostToolUseFailure / PermissionDenied /
# SubagentStart / SubagentStop。原来这里写的「能力更少」三条全是错的（照兼容声明猜的）。
# 唯一的真差别：**没有回合字段**（`prompt_id` / `turn_id` 都不存在），走上面的 session 回落。
# 配置在 `~/.workbuddy-ai/settings.json`（旧路径 `~/.workbuddy/settings.json` 仅作回退）。
#
# ⚠️ **未实机验证**：本机没装 WorkBuddy，事件集来自其 Claude Code 兼容声明。
# 回合字段两个都试 —— 猜错的后果是 turn 记账全空、工具之间闪 idle。
WORKBUDDY = {
    "id": "workbuddy",
    "label": "WorkBuddy",
    # 实测：两个候选字段一个都不存在，靠 session 回落
    "turn_fields": (),
    # ⚠️ **不含 startup**（与 CC 相反）。实抓的真实顺序是
    # `UserPromptSubmit → SessionStart(startup) → PreToolUse → …` ——
    # WorkBuddy 的 SessionStart **晚于**回合开始。把它当重置会清掉刚开的回合，
    # 于是 display_state 认为工具「所属 turn 已收尾」而跳过它：整轮没有 executing，
    # 只剩 writing 再掉回 idle（实测就是这个形状）。
    # startup 时会话本来就是新的，不重置没有任何损失；真正需要重置的是 clear。
    "reset_sources": ("clear",),
    "events": dict(_BASE_EVENTS,
                   PostToolUseFailure="post_tool_call",
                   PermissionDenied="post_tool_call"),
}
