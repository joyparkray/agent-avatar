# Claude Code connector

<p align="center">
  <b>English</b> · <a href="README.zh.md">简体中文</a>
</p>

> Makes Agent Avatar change expression as Claude Code thinks, runs a tool or spawns a
> subagent. **WorkBuddy reuses this same hook** (see §5).

The event shapes below were captured from a real run (**Claude Code 2.1.212**, macOS,
sampler running under an isolated `--settings`), not guessed from the docs.

---

## 1. Install

**The app does this for you**: Settings → Agent → Connectors → Install. It ships the plugin
and a Python interpreter inside itself, registers it through `claude` and reports whatever
the CLI said if it fails.

By hand — for a Claude Code the app cannot see (WSL, a container, another machine), or if
you want to read the commands first:

```bash
sh connectors/build-bundle.sh ./connector-tree
cd connector-tree/marketplace
python localize.py claude-code
claude plugin marketplace add ./
claude plugin install agent-avatar@agent-avatar
```

**Start a new session** afterwards — plugins load at session start. Full details, including
the other four harnesses, are in [the connectors README](../marketplace-README.md).

> `localize.py` writes the interpreter that is running it into the hook command line. It is
> **not optional on Windows**, where `python3` is not Python: it resolves to a 0-byte
> Microsoft Store placeholder that starts, prints "Python was not found" and exits 9009.
> 9009 is not 2, so no harness treats it as a failure — the only symptom is an avatar that
> never moves. Worth running on macOS too: it pins the interpreter rather than leaving
> `/usr/bin/python3`, which on a Mac without the Xcode command line tools is itself a
> placeholder that pops an install dialog.

The tree is **self-contained** by construction: the hook script plus the two Bridge
modules. The single source of truth for the state machine stays in `../../bridge/` and is
copied in at build time, never by hand.

During development you can skip installing and load the tree directly (`/reload-plugins`
after an edit):

```bash
claude --plugin-dir <tree>/plugins/claude-code/agent-avatar
```

Once installed, `claude plugin details agent-avatar@agent-avatar` should show:

```
Hooks (10)  SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
            PostToolUseFailure, PermissionDenied, SubagentStart, SubagentStop, Stop
            (harness-only — no model context cost)
Projected token cost
  Always-on:   ~0 tok   added to every session
```

**Zero context cost** is the direct payoff of the pure-observer design — Claude Code
recognises this as harness-level and puts nothing into the conversation.

### Layout (the opposite of Codex — don't mix them up)

```
agent-avatar/
├── .claude-plugin/plugin.json   ← only the manifest may live here
└── hooks/hooks.json             ← hooks go in the **hooks/ subdirectory**
```

⚠️ Codex wants `hooks.json` at the **plugin root**; Claude Code wants it inside
**`hooks/`**, and the CC docs explicitly warn that **no** directory other than
`plugin.json` may be placed in `.claude-plugin/`.

The path variable is **`${CLAUDE_PLUGIN_ROOT}`** (Codex uses `${PLUGIN_ROOT}`), quoted the
way the official `hookify` plugin does it:
`python3 "${CLAUDE_PLUGIN_ROOT}/hooks/agent-avatar-hook.py" ; exit 0`.

### No separate hook approval

Claude Code has **no** per-hook review of the kind Codex has. The official security model
is:

> "Plugins and marketplaces are highly trusted components that can execute arbitrary code
> on your machine with your user privileges. Only install plugins and add marketplaces
> from sources you trust."

**Installing is trusting.** The review happens *before* installing — the "Will install"
block on the `/plugin` details page lists the hooks, agents and MCP servers a plugin
brings.

### Fallback: write it into settings.json by hand

Without the plugin, the hooks can go straight into `~/.claude/settings.json` (the format
matches the `hooks` object in `hooks/hooks.json`). **But then you own the absolute path**,
which means you take on the risk in §2 — and you **must** add `; exit 0`. The plugin path
does not have this problem.

## 2. 🔴 One thing to know before installing

**Claude Code treats exit code 2 as a block**, and **what a crash in this script costs
depends on the event**:

| Event | Consequence of exit 2 |
|:--|:--|
| `PreToolUse` | **the tool call is blocked** |
| `Stop` | **stopping is blocked — the conversation cannot end** |
| `SubagentStop` | the subagent cannot finish |
| `UserPromptSubmit` | your prompt is rejected |
| `PostToolUse` / `PostToolUseFailure` / `SessionStart` / `SessionEnd` / `SubagentStart` / `PermissionDenied` | ignored (safe) |

The script itself always exits 0 (every exception is swallowed). **The danger is the
script never running at all**: `python3 <a file that does not exist>` exits with **exactly
2**. So:

> **A wrong path / a moved checkout / a different Python** = your tools get blocked and
> the conversation will not stop.

This actually happened once, on Hermes (2026-08-28). **Unregister before you move or
rename the script.**

**We deliberately do not register** these events: `PermissionRequest` (a blocking decision
hook — with no response CC denies the tool call outright rather than falling back to the
confirmation prompt, see
[anthropics/claude-code#46193](https://github.com/anthropics/claude-code/issues/46193)),
`WorktreeCreate` (requires printing a path to stdout, so a passive hook makes `claude -w`
report "no successful output"), `PreCompact` and the remaining blockable events.
**The expression system never enters a decision path.**

---

## 3. Event mapping

| Claude Code | Internal event | Note |
|:--|:--|:--|
| `SessionStart(source=startup\|clear)` | `on_session_start` | only these two start a new session |
| `SessionStart(source=resume\|compact\|fork)` | *ignored* | continuation of the same session; a reset would drop live subagents |
| `UserPromptSubmit` | `pre_llm_call` | |
| `PreToolUse` | `pre_tool_call` | |
| `PostToolUse` | `post_tool_call` | |
| `PostToolUseFailure` | `post_tool_call` + `status=error` | more explicit than Hermes inferring it from status |
| `PermissionDenied` | `post_tool_call` + `status=blocked` | triggers the `blocked` overlay reaction |
| `SubagentStart` / `SubagentStop` | `subagent_start` / `subagent_stop` | `agent_id` → `child_session_id` |
| `Stop` (ignored while `stop_hook_active`) | `post_llm_call` | subagents are not cleared: background ones outlive Stop |
| `SessionEnd` | `on_session_finalize` | |

**Field mapping**: `prompt_id` → `turn_id`, `tool_use_id` → the tool pairing key,
`agent_id` → subagent id.

---

## 4. Three ways it differs from Hermes (measured)

1. **Subagent events carry the *parent* `session_id`**, distinguished by `agent_id`. On
   Hermes a subagent has its own session_id and needs an ignore-list — **CC needs none of
   that**. The rule: an event carrying `agent_id` never drives the avatar, except
   `SubagentStart/Stop`, which is the parent session's bookkeeping.
2. **Orphan `SubagentStop`**: `/compact` emits a stop for an id that was never seen. CC
   wants `ignore` (handle only what pairs up), Hermes wants `dequeue-oldest` — **the two
   requirements are opposites**, which is why this is the one parameterised policy in
   `bridge/state_machine.py`.
3. **`prompt_id` *is* the turn id**: measured, it stays constant from `UserPromptSubmit`
   to `Stop` within a turn and changes on the next one, while `session_id` does not. So the
   Hermes turn bookkeeping is reused unchanged, and the avatar does not drop back to idle
   between tools.

**Known, unhandled**: if another hook blocks `SubagentStop`, the same subagent comes back
(officially, exit 2 on `SubagentStop` prevents stopping). We under-count one `awaiting`
briefly, until the real stop arrives. It only happens when another hook actively blocks,
so it is left alone.

---

## 5. WorkBuddy reuses this hook

WorkBuddy's agent core is CodeBuddy Code — shaped like Claude Code: the same
`hook_event_name` stdin contract, the same `hooks/hooks.json` plugin layout, and even
`${CLAUDE_PLUGIN_ROOT}` is set. So **the scripts in this directory are reused as they
are**; only the config directory differs (the app reads `~/.workbuddy`, the standalone CLI
reads `~/.codebuddy`). The install steps and the trap those two homes set are in
[`../workbuddy/README.md`](../workbuddy/README.md).

WorkBuddy has no `PostToolUseFailure`. Events that are never sent do no harm — anything
missing from the mapping table is ignored.

> **DeepSeek Harness is *not* in this group (an early call that turned out wrong).** The
> design note used to say "dsh ships a Claude Code hook bridge, so the registration on this
> page can be reused unchanged". A real run on 2026-08-28 disproved it: the dsh 0.1.1-rc.2
> on that machine had no hook bridge package at all. Its extension point is **cordis
> events**, whose names, payloads and registration have nothing in common with CC. dsh
> therefore has its own translation layer and in-process plugin — see
> [`../dsh/README.md`](../dsh/README.md).

---

## 6. Checking it yourself

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt_id":"t1"}' | \
  /usr/bin/python3 /path/to/agent-avatar/connectors/claude-code/agent-avatar-hook.py
cat "$TMPDIR/agent-avatar-state.json"     # expect state: writing
```

To exercise the whole chain without touching your own `~/.claude/settings.json`
(recommended): put the §1 block into a standalone file, then run
`claude -p --settings <that file> '...'`. That is exactly how the event baseline for this
connector was obtained.
