# Hermes adapter (a boundary that can be removed whole)

<p align="center">
  <b>English</b> · <a href="README.zh.md">简体中文</a>
</p>

> What M1 §1.2 lands on: **delete this boundary and Agent Avatar is still complete** — the
> character, the motions and the file/global audio sources depend on nothing from Hermes.
> Users who do run Hermes get semantic expressions and TTS lip sync on top.

## What the boundary contains

| Location | Role |
|:--|:--|
| `plugin/agent-avatar/` | **the default integration**: a Hermes plugin (`plugin.yaml` + `__init__.py`) that translates events and carries the token out |
| `hermes plugins install` | how the plugin is registered — **without touching the user's config.yaml**. Hermes installs from git only, so the built tree is committed to a throwaway repository first; see [the connectors README](../marketplace-README.md) |
| — | Hermes is the one harness of the five that **needs no interpreter localisation**: the plugin is an in-process Python package running inside Hermes's own interpreter and spawns nothing, so the "`python3` is a Store stub on Windows" mine cannot go off here — which also made it the **baseline** for the Windows wiring |
| `agent-avatar-hook.py` | the fallback shell-hook entry point; behaves identically to the plugin |
| `test_agent_avatar_hook.py` / `test_agent_avatar_plugin.py` | unit tests for both entry points, depending on neither the avatar nor any third-party project |
| `../../desktop/src-tauri/src/hermes.rs` | the two Tauri commands `read_semantic_state` / `discover_audio_endpoint` |
| `../../docs/CONNECTORS.md` | how a user installs it |

**Not part of this boundary**: `../../bridge/state_machine.py` is the harness-agnostic
shared state machine (since M3 it is shared by the Claude Code, Codex and other adapters).
**Do not delete it** when removing Hermes.

## Two entry points, one state machine

```
Hermes plugin (in-process)  ┐
                            ├─► _payload() translation ─► bridge/state_machine.update() ─► state file
shell hook (subprocess)     ┘
```

`_payload()` in `plugin/agent-avatar/__init__.py` reproduces the translation rules of
`agent/shell_hooks.py:_serialize_payload()`, so **both entry points feed the state machine
the same shape** — there is no second branch inside the state machine written for the
plugin.

Hermes's event names simply **are** the state machine's internal vocabulary (a historical
accident, not a dependency), so this layer needs no event-name mapping table. Other
harnesses do.

## Why the plugin is the default (rather than the shell hook)

- it does not modify the user's `~/.hermes/config.yaml` (YAML is user-owned; breaking it
  would be our fault);
- it needs neither a shell-hook allowlist nor `hooks_auto_accept: true` — that is Hermes's
  global switch for CI and headless use, and it exempts **every** unseen shell hook from
  confirmation;
- the event list is a YAML list inside `plugin.yaml`, so the "ten YAML blocks and one of
  them is missing" trap does not exist.

The cost: the plugin runs in-process, and Hermes's `invoke_hook` only wraps it in
try/except — **there is no timeout**. So the write in `bridge/state_machine.py` is
non-blocking (`LOCK_NB` plus a bounded 0.5s retry; the event is dropped if the lock cannot
be taken) and does not `fsync` — a transient state file needs no power-loss durability, and
the atomicity of `os.replace` is enough.

## How to remove it

1. Delete this directory (keep `../../bridge/`).
2. Delete `desktop/src-tauri/src/hermes.rs`, and drop `mod hermes;` plus the two `hermes::`
   commands from `generate_handler!` in `lib.rs`.

The front end needs no changes: when `SemanticDriver` cannot reach the command it falls
back on failure (three consecutive failed reads → it stays on `idle`), and with
`discover_audio_endpoint` gone no Hermes WebSocket is established — the Hermes audio source
in the right-click menu simply has no endpoint. The file and global audio sources, and
every avatar motion, are entirely unaffected.

## Relationship to upstream

The state machine was ported from
`Star-Office-UI-Hermes/integrations/hermes/star_office_hook.py` (MIT; the attribution is
kept in the file header). `push()` — the HTTP report to the Star Office backend — and its
delivery orchestration were **not** ported; Agent Avatar only consumes the aggregated base
state. At runtime there is **zero dependency** on that project: this directory and
`../../bridge/` are stdlib-only, and the Rust side only reads a state file it wrote itself.
