# Codex connector

<p align="center">
  <b>English</b> · <a href="README.zh.md">简体中文</a>
</p>

> The Codex desktop app is the **only harness where both channels work**: semantic state
> (this page) **and** voice lip sync (ChatGPT Voice → system audio → the avatar's `global`
> audio source, see §4).

Contract source: [the official Codex Hooks documentation](https://learn.chatgpt.com/docs/hooks).

---

## 0. ChatGPT and Codex inside the ChatGPT app are two different things

Codex has been folded into the ChatGPT app (`codex app` is what launches it). Two surfaces
in one app, and they expose different things:

| Surface in the ChatGPT app | Speaks (lip sync) | Semantic state (expressions) |
|:--|:--|:--|
| **Codex** (the coding agent) | ✅ system audio | ✅ lifecycle hooks |
| **ChatGPT chat / voice mode** | ✅ system audio | ❌ **no lifecycle hooks** |

The docs are explicit: *"When your plugin is enabled, **Codex** can load lifecycle hooks
from your plugin."* — hooks run inside **Codex's agent loop**; an ordinary ChatGPT
conversation has no such events. The extension points on the chat side are skills,
connectors, MCP and apps, all of which are about *what the model may call*, not a push
signal for *what it is doing right now*.

**So on the chat side we get the mouth but not the face** — and the mouth needs no
integration at all: voice mode plays through system audio, which the avatar's `global`
source already captures (§4).

---

## 1. Install

**The app does this for you**: Settings → Agent → Connectors → Install.

By hand — for a Codex the app cannot see, or if you want to read the commands first:

```bash
sh connectors/build-bundle.sh ./connector-tree
cd connector-tree/marketplace
python localize.py codex
codex plugin marketplace add ./
codex plugin add agent-avatar@agent-avatar
```

🔴 Codex's verbs are **`plugin add` / `plugin remove`**, not install/uninstall.

🔴 **On Windows `codex` is not on PATH, but it exists.** The ChatGPT app ships it at
`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` — the directory name is a build hash,
so take the newest one and call it by absolute path.

`localize.py` pins the interpreter into the hook command line. Codex has a Windows-specific
`commandWindows` override field, so the POSIX `/usr/bin/python3` line is kept as-is and both
platforms share one hooks.json. Full details, including the other four harnesses, are in
[the connectors README](../marketplace-README.md).

Then: **fully quit and reopen the ChatGPT app** → **enable Agent Avatar on the Plugins
tab** → **review and trust its hooks**.

> 🔴 **Step 3 lives behind `/hooks`, not on the Plugins page.**
> After the plugin is installed and enabled, its hooks are still **untrusted** and are
> **silently skipped** — no error, no prompt; it just looks like "the plugin is clearly
> enabled but the avatar doesn't move". Confirmed on 2026-08-28: with the plugin
> `installed, enabled`, a Codex run produced no state file at all; the same command with
> `--dangerously-bypass-hook-trust` wrote one immediately.
>
> **Type `/hooks` in a Codex session** and trust the Agent Avatar hooks. Officially:
> *"Use `/hooks` in the CLI to inspect hook sources, review new or changed hooks, trust
> hooks…"*, and *"If hooks need review at startup, Codex prints a warning that tells you to
> open `/hooks`."*
>
> ⚠️ **Trust is keyed to a hash of the hook's content**: *"Codex records trust against the
> hook's current hash, so new or changed hooks are marked for review and skipped until
> trusted."* — so **every plugin upgrade that changes `hooks.json` needs trusting again**
> in `/hooks`, or it goes quietly dead after the upgrade. This is the easiest operational
> trap in the whole integration.
>
> Automation can bypass it with `--dangerously-bypass-hook-trust` (single invocation only).
> **Do not** bake that into your everyday command — it bypasses a real defence against
> hooks executing arbitrary code.

`codex plugin marketplace add ./` registers the built tree as a local marketplace by
writing an entry into `~/.agents/plugins/marketplace.json`; `codex plugin add` then copies
the plugin into `~/.codex/plugins/cache/…` and reports that copy as the installed root.

> 🔴 **A marketplace entry's path must be a `./` path relative to the marketplace root**,
> and must stay inside it. Officially: *"Codex resolves `source.path` relative to the
> marketplace root"*. **An absolute path is silently discarded** — no error, and the plugin
> simply does not appear in `codex plugin list` or on the app's Plugins tab. Our first
> hand-rolled version did exactly that; found on 2026-08-28. Registering through
> `codex plugin marketplace add` avoids the whole question.
>
> Diagnose with `codex plugin list` (no need to open the app):
> - the line is missing entirely → the marketplace was never added, or its path is wrong
> - `not installed` → registered but not installed; run `codex plugin add agent-avatar@agent-avatar`
> - `installed, enabled` → the plugin is in place. **If the avatar still does not move, the
>   hooks are untrusted** — run `/hooks` in a Codex session. To verify, run a turn and check
>   whether `$TMPDIR/agent-avatar-state.codex.json` appears.

**Why a plugin rather than editing `hooks.json` by hand:**

1. **the user can toggle it in the app**, without touching a config file;
2. the hook command locates itself through **`${PLUGIN_ROOT}`** — the path cannot break
   because the repository moved. That matters; see §2;
3. one plugin directory is discovered by both the ChatGPT app and the Codex CLI.

Uninstall: `codex plugin remove agent-avatar`, then
`codex plugin marketplace remove agent-avatar`.

### Fallback: write hooks.json directly

Codex also reads `~/.codex/hooks.json` and `<repo>/.codex/hooks.json` (the project-level
one is handy for isolated tests). The events are the same as in the plugin, but **you
hard-code the absolute path yourself**, which means you take on the risk in §2 — and you
**must** add `; exit 0`.

## 1.5 The plugin's layout (two discovery mechanisms, and both are needed)

```
agent-avatar/
├── .codex-plugin/plugin.json   ← contains a top-level "hooks": "./hooks.json"
├── hooks.json                  ← **must be at the root**
└── scripts/agent-avatar-hook.py   (+ state_machine.py, pascal_events.py)
```

**Both are required, because the CLI and the app discover hooks differently** (measured
2026-08-28):

| | codex-cli 0.144.4 | ChatGPT app |
|:--|:--|:--|
| top-level `hooks` field in `plugin.json` | ✅ honoured | ❌ ignored |
| `hooks.json` at the root | ❌ ignored | ✅ honoured |

What was measured: field only → the CLI fires, the app does not; root file only → **the CLI
does not fire at all** (checked twice, with a relative path and with `${PLUGIN_ROOT}`,
ruling out path resolution); both present → the CLI fires again. The field points at the
same `./hooks.json`, so nothing is registered twice.

The root layout is what Figma and Replay.io actually do in the official directory — but
note that both are `not installed` on this machine and are only directory entries, so they
prove the packaging convention, not the CLI's loading behaviour.

> One phenomenon that is easy to misread: if the validator had actually **rejected** the
> top-level `hooks` field, the plugin card would not show as installed and enabled. A card
> that renders normally means the manifest was accepted — the app simply does not discover
> hooks through that field.

`interface` must also carry `capabilities` and `defaultPrompt` (shaped like Figma's) or
validation fails. We declare `"capabilities": ["Read"]` — a pure observer that neither
writes nor interacts.

## 2. 🔴 Exit code 2 blocks tools dead

Codex treats **exit code 2 as a block**, over a wider range than Claude Code:
`PreToolUse` (denies the tool), **`PostToolUse` (also blocks — CC ignores that event)**,
`PermissionRequest`, `UserPromptSubmit`, `Stop` / `SubagentStop`.

The script itself always exits 0. **The danger is the script never running**: `python3 <a
file that does not exist>` exits with **exactly 2**. Measured comparison (done on Claude
Code; Codex behaves the same):

| How it is registered | When the path breaks |
|:--|:--|
| `python3 /bad/path.py` | **tools are blocked dead** |
| `python3 /bad/path.py ; exit 0` | tools run normally |

The same accident really happened once on Hermes (2026-08-28: the script was moved and the
process was not restarted). **The plugin path avoids it structurally**: `${PLUGIN_ROOT}` is
resolved by Codex, so it points wherever the plugin is. Even so, the plugin's command still
carries `; exit 0` — belt and braces.

**We deliberately do not register** `PermissionRequest`: it is a blocking decision hook,
and the expression system never enters a permission decision path. Codex has no passive
`PermissionDenied` the way Claude Code does, so **there is no `blocked` reaction on
Codex** — an acceptable gap, not worth trading for a hook that can block tools.

## 2.5 Recognising our hooks inside `/hooks`

The Description column on the list page shows **Codex's own generic event description**
("Before a tool executes"), not the plugin's — from the list alone you cannot tell whose
hooks are whose.

**Press `enter` to drill in**, and the detail page names the source:

```
Event      PreToolUse
Matcher    *
Source     Plugin — agent-avatar@agent-avatar  ← this line is the identifier
Command    /usr/bin/python3 …/agent-avatar/<version>/scripts/agent-avatar-hook.py ; exit 0
Timeout    600s
Trust      Modified since last trusted — review required
```

`agent-avatar` is recognisable in both `Source` and `Command`, so **Codex has already
solved identification** — it just takes one level of drilling.

> **We deliberately do not set `statusMessage`.** It is the only custom text field on an
> individual hook, but **it does not appear on the review page** (which shows only the six
> lines above), so it does not help identification — and it is the status line shown *while
> the hook runs*. We fire on every single tool call, so setting it would flash a line of
> text at every tool call. A pure observer should be invisible, and our hook is
> sub-millisecond, so there is no "let the user know what they are waiting for" need
> either. (Added briefly on 2026-08-28; it neither helped identification nor did anything
> except invalidate existing trust, and was withdrawn.)

> ⚠️ **Any change to `hooks.json` invalidates trust** — trust is keyed to a hash of the
> hook's content, and the detail page then reads `Modified since last trusted`. Re-trust
> through `/hooks` after every plugin upgrade.

### Observation: this version of `/hooks` does not list `SessionEnd`

Measured (codex-cli 0.144.4 + ChatGPT app, 2026-08-28): we declare 8 events and `/hooks`
listed only 7 for review (`PreToolUse` / `PostToolUse` / `SessionStart` /
`UserPromptSubmit` / `SubagentStart` / `SubagentStop` / `Stop`) — **`SessionEnd` did not
appear in the event table at all**, although the docs list it as supported.

Consequence: `on_session_finalize` may never fire on Codex, and session records are not
cleaned up. **Not fatal**: `Stop` closes the turn out to `idle`, and the avatar side has a
300s staleness fallback. The declaration stays, so it starts working by itself whenever a
version begins emitting the event.

---

## 3. Three differences from Claude Code

The translation layer is shared (`../../bridge/pascal_events.py`); Codex and CC differ in
exactly three places:

| | Claude Code | Codex |
|:--|:--|:--|
| turn field | `prompt_id` | **`turn_id`** (officially, all turn-scoped hooks carry it) |
| tool failure | its own `PostToolUseFailure` event | **none** — inferred from `tool_response` (`exit_code` / `error` / `is_error`) |
| denial signal | passive `PermissionDenied` | **none** (only the blocking `PermissionRequest`, which we do not register) |
| `SessionStart.source` | `startup\|resume\|clear\|compact\|fork` | the same, minus `fork` |

Everything else matches: the field names `session_id` / `tool_use_id` / `agent_id` are
identical, the registration structure is identical, and both have subagent events (**the
early design note claiming "Codex has no subagent events" was wrong**).

## 4. Voice lip sync: nothing to integrate

ChatGPT Voice in the Codex app **plays through system audio**, which the avatar's `global`
source already captures — **there is not one line of Codex-specific audio code**. Switch
the audio source to Global in the avatar's right-click menu; on macOS the system asks once
for microphone permission, and allowing it is enough (it goes through a Core Audio process
tap, so **no screen-recording permission** and no trip to System Settings). On Windows the
same source runs on WASAPI loopback.

This combination is Codex's key advantage over the other harnesses: Claude Code gives
semantic state but no voice, the Claude Desktop chat tab gives voice but no state — **only
the Codex app gives both**.

## 5. Checking it yourself

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"s1","turn_id":"t1"}' | \
  /usr/bin/python3 /path/to/agent-avatar/connectors/codex/agent-avatar-hook.py
cat "$TMPDIR/agent-avatar-state.json"     # expect state: writing, detail starting with "Codex"
```

**Not verified against Codex.app**: verification was done on codex-cli 0.144.4, without the
desktop app installed. The event shapes follow the official documentation; **once the
desktop app is installed it is worth capturing one real run the way Claude Code was
captured** — a sampler script that only records stdin, under an isolated config, compared
against the fields in §3.
