# Connectors

A connector is a small plugin for your agent harness. It reads the harness's own hook
events, translates them into the [Bridge Protocol](../bridge/README.md) vocabulary, and
writes the result to a state file the avatar watches. It never modifies the harness and
never blocks it: every hook exits 0, always.

Five harnesses are supported and have all been verified on real sessions.

## Install

**Use the app.** Settings → Agent → Install, next to your harness. The plugin and the
Python it needs are inside the application, so nothing is downloaded; registration goes
through your harness's own CLI. The button reports which step failed, and what the
harness itself said, if it does.

Afterwards, **start a new session** — plugins load at session start. Codex additionally
needs `/hooks` trust and WorkBuddy an app restart; the app spells out whichever applies.

**By hand** — for a harness the app cannot reach (WSL, a container, another machine),
or to read the commands first: see [the connectors README](../connectors/marketplace-README.md).
It is the same set of commands, written out.

Then open the avatar's right-click menu → **Agent State Source** and pick the matching
harness (or *Auto*).

## What you must do after installing

This is where most "it does nothing" reports come from. The step differs per harness:

| Harness | After installing | Can the installer do it for you? |
|---|---|---|
| Claude Code | Nothing — installing is trusting | ✅ |
| DeepSeek Harness | Nothing — hot reload picks it up | ✅ |
| Hermes | `plugins enable agent-avatar` | ✅ the installer can run it |
| WorkBuddy | **Restart the app** | ⚠️ you have to do it |
| Codex | **Approve the hooks with `/hooks` in a session** | ❌ cannot be automated |

### Codex needs approving, and re-approving

Codex tracks hook trust **by content hash**. The plugin will show as installed and
enabled while its hooks are silently skipped, which looks exactly like a broken plugin.
Run `/hooks` in a Codex session and approve each entry. Any connector upgrade changes the
hash, so you approve again after updating.

### WorkBuddy has two config homes

The same CodeBuddy CLI reads `~/.codebuddy` when run standalone and `~/.workbuddy` when
run by the WorkBuddy app. A plugin installed into the wrong one tests perfectly from the
command line and does nothing inside the app. The installer registers into both homes it
finds, and reads both when reporting whether the connector is installed.

`CODEBUDDY_CONFIG_DIR` is the variable that decides where plugins are recorded — measured
against the real CLI, `WORKBUDDY_CONFIG_DIR` does not move them.

### WorkBuddy's command line is inside the app

Installing the WorkBuddy desktop app does not put a `codebuddy` on your PATH; the CLI it
uses lives inside the application directory. Agent Avatar looks there as well as in the
npm global directory, so you do not need to install the npm package separately.

On Windows that bundled file is a Node script with no extension, which Windows cannot
launch on its own, so it is run through Node — meaning this path needs a Node on your
machine. If you have neither a Node nor the npm `codebuddy`, install the npm package.

## Per-harness details

Each connector directory has its own guide, including the exact events used and the
gotchas found while integrating it:

- [Claude Code](../connectors/claude-code/README.md)
- [Codex](../connectors/codex/README.md) — also covers ChatGPT Voice lip sync
- [Hermes](../connectors/hermes/README.md)
- [DeepSeek Harness](../connectors/dsh/README.md)
- [WorkBuddy](../connectors/workbuddy/README.md)

## Adding a harness

The contract you implement is in [bridge/README.md](../bridge/README.md). In short:
translate that harness's events into the shared vocabulary, then feed them to the shared
state machine — the machine itself is never copied, only reused.

Start by capturing what your harness actually emits rather than trusting its docs.
`connectors/sample-stdin.py` records raw hook payloads; the DeepSeek connector has
`sample-events.mjs` for its in-process event bus. Every one of the five integrations
turned up at least one documented behaviour that the real payloads contradicted.

Two rules that are not negotiable:

- **Always exit 0.** Some harnesses treat exit code 2 as "block this tool call", and a
  missing Python file exits 2. A crashing observer must never be able to stop an agent.
- **Observe, never answer.** For in-process hooks, return nothing; on event buses,
  subscribe only to notification-style events, never to ones whose return value changes
  harness behaviour.

## Packaging

`connectors/assemble.sh <harness> <target>` builds a self-contained plugin tree by
copying `bridge/` into the plugin skeleton; `connectors/assemble.sh all` builds all five
into `release/connectors/`. The state machine has exactly one source of truth — plugin
trees are assembled, never hand-copied.
