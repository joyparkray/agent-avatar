# WorkBuddy connector

<p align="center">
  <b>English</b> · <a href="README.zh.md">简体中文</a>
</p>

> Verified on real hardware: **2026-08-28, WorkBuddy (macOS app, closed source) — both a
> new session inside the app and the CodeBuddy Code CLI v2.115.0 it ships with**.
> Trajectory: `writing → executing → writing → idle`.

## WorkBuddy's agent core is CodeBuddy Code

There is no hook system in the Electron shell; what actually runs the agent is the CLI
distributed inside the app:

```
/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
```

That is **CodeBuddy Code**, shaped like Claude Code: the `hook_event_name` stdin contract,
the `hooks/hooks.json` plugin layout, `-p` headless mode, `--settings` for an isolated
config, `--plugin-dir` for local loading. **Being closed source is no obstacle** — a hook is
an external process contract, and we only read JSON from stdin.

Inside a plugin, **both** `${CODEBUDDY_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` are set
(the CLI writes both), so a Claude Code plugin directory loads as-is — confirmed by
measurement.

## 1. Install

**The app does this for you**: Settings → Agent → Connectors → Install.

By hand — for a WorkBuddy the app cannot see, or if you want to read the commands first:

```sh
sh connectors/build-bundle.sh ./connector-tree
cd connector-tree/marketplace
python localize.py workbuddy
codebuddy plugin marketplace add ./
codebuddy plugin install agent-avatar@agent-avatar
```

Same shape as Claude Code, with `codebuddy` in place of `claude`. Full details are in
[the connectors README](../marketplace-README.md).

🔴 **Which config directory you install into is the thing that matters.** The same CLI has
two homes: run standalone it defaults to `~/.codebuddy`, but **the WorkBuddy app reads
`~/.workbuddy`** (`WORKBUDDY_CONFIG_DIR` on the app side, `CODEBUDDY_CONFIG_DIR` on the CLI
side). Installing into the wrong home produces the most confusing symptom of all: **every
command-line test passes and a new session in the app does nothing at all** (hit for real).
If you only use the app, point `CODEBUDDY_CONFIG_DIR` at `~/.workbuddy` before installing.

`localize.py` pins the interpreter into the hook command line — **not optional on Windows**,
where `python3` resolves to a 0-byte Microsoft Store placeholder that starts, prints "Python
was not found" and exits 9009. Since 9009 is not 2, nothing treats it as a failure and the
only symptom is an avatar that never moves. On Windows there is also no fixed path to the
CLI bundled with the app: set `CODEBUDDY_CLI`, or install it with
`npm install -g @tencent-ai/codebuddy-code`.

After installing, **the app must be restarted** before it loads (the CLI picks it up on its
next run, and `/reload-plugins` works inside a session).

Uninstall (**again, point at the right home**, or you will remove the other copy):
```sh
CODEBUDDY_CONFIG_DIR=~/.workbuddy codebuddy plugin uninstall agent-avatar
CODEBUDDY_CONFIG_DIR=~/.workbuddy codebuddy plugin marketplace remove agent-avatar
```

## 2. The three claims this document used to make were all wrong

The old version inferred them from "WorkBuddy claims Claude Code compatibility", and the
real thing said otherwise:

| Old claim | Actually |
|:--|:--|
| config lives in `~/.workbuddy-ai/settings.json` | **`~/.workbuddy/settings.json`** (transcripts in `~/.codebuddy/projects/`) |
| no subagent events | `SubagentStart` / `SubagentStop` both exist |
| no `PostToolUseFailure`, no `PermissionDenied` | both exist (a `PermissionDenied` was captured live) |

The full vocabulary in the CLI:

```
SessionStart SessionEnd UserPromptSubmit PreToolUse PostToolUse PostToolUseFailure
Stop SubagentStart SubagentStop PermissionDenied PermissionRequest PreCompact
PostCompact WorktreeCreate WorktreeRemove
```

The last group is never registered, per §7 of the protocol (`PermissionRequest` is a
blocking decision hook; `WorktreeCreate` requires the hook to do work).

## 3. Two genuine differences (both found by capture)

Real timing (with `sleep 4`):

```
UserPromptSubmit  0.00s
SessionStart      0.41s   ← **after the turn has already started**
PreToolUse        4.31s   (Bash, tool_use_id=call_…)
PostToolUse       8.37s
Stop             10.00s
```

**One: `SessionStart` arrives late.** Claude Code sends `SessionStart` before
`UserPromptSubmit`; WorkBuddy does the reverse. Treating the late `SessionStart(startup)`
as a reset wipes the turn that just opened, after which `display_state` judges the tool's
turn to have already closed and skips it — **no `executing` for the entire round**. So the
config table keeps only `clear` in `reset_sources`: at startup the session is new anyway,
and not resetting costs nothing.

**Two: there is no turn field.** Neither `prompt_id` nor `turn_id` exists in the payload
(both strings appear **0 times** in the CLI). The translation layer falls back to
`session_id` — one session runs one turn at a time, and the boundaries come from
`UserPromptSubmit` / `Stop`. Without the fallback, turn bookkeeping is empty and the avatar
flickers back to idle between tools.

> `generation_id` looks like a turn id but is not: there is one **per model generation**,
> and the one on `Stop` differs from the one on the tool. Using it as the turn id would
> fail to close the turn the tool belongs to.

## 4. Sampling (the first step of any integration)

```sh
CLI=/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
"$CLI" -p --settings <sampler-settings.json> -- "run sleep 4 with bash, then answer only: done"
```

In that settings file, register every event's command as `python3 ../sample-stdin.py ; exit
0`; output goes to `$AGENT_AVATAR_SAMPLE`. **Use an isolated `--settings` and do not touch
the user's own config.**

Two traps:

- `--plugin-dir` is **variadic** and swallows the prompt that follows it — write
  `--plugin-dir DIR -- "prompt"`, or the CLI exits 0 silently and answers nothing.
- In non-interactive mode the tool needs to be permitted; add
  `"permissions": {"allow": ["Bash(sleep:*)"]}` to the isolated settings, which is safer
  than `-y` (which bypasses every permission check).

## 5. Not yet verified

- **The subagent trajectory has not been run for real** (`SubagentStart` / `SubagentStop`
  are in the vocabulary, but the test cases are constructed).
- The other `SessionStart` sources (`resume` / `compact` / `clear`) have not been captured;
  Claude Code's judgement is reused, since it is the same CLI.
