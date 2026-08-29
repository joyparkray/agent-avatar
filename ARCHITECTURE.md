# Architecture

Agent Avatar has three parts with different audiences and different release cadences.

```
Your agent harness                      Claude Code · Codex · Hermes · DSH · WorkBuddy
        │  its own hook events
        ▼
connectors/<harness>/                   translates events into one shared vocabulary
        │
        ▼
bridge/state_machine.py                 aggregates them into one mutually exclusive state
        │
        ▼
$TMPDIR/agent-avatar-state[.harness].json      the wire format — a file, polled at 5 Hz
        │
        ▼
desktop/                                state → motion / expression, plus lip sync
```

The two halves know nothing about each other beyond that file. Anything that can write
it can drive the avatar; anything that can read it can be the avatar.

## Why the state machine is the interesting part

Defining event names is easy. The hard part is turning a stream of interleaved,
out-of-order, sometimes-missing events into *one current state* — across concurrent
tools, subagents, session resets and killed processes. That logic lives in exactly one
place, `bridge/state_machine.py` (standard library only, so it runs under whatever
Python the harness provides), and every connector reuses it rather than reimplementing.

Self-contained plugin trees are **assembled** from it by `connectors/assemble.sh`, never
hand-copied. One source of truth.

See [bridge/README.md](bridge/README.md) for the protocol, the state vocabulary, the
priority order, and the safety constraints connectors must respect.

## desktop/

A Tauri 2 application: Rust for the window and the OS integrations, TypeScript for
everything drawn.

### Rust (`desktop/src-tauri/src/`)

| Module | Responsibility |
|---|---|
| `lib.rs` | Window setup, the hit-test thread, tool windows, logging, command registration |
| `hit_test.rs` | Whether the cursor is over the character, and therefore whether the window swallows clicks |
| `config.rs` | Config file, model directory, install/delete/scan of user models |
| `hermes.rs` | Reads the connector's state file; discovers a local Hermes audio endpoint |
| `static_server.rs` | Serves model files to the webview in release builds, with traversal rejected |
| `native/AudioCapture.m` | System audio loudness via Core Audio process taps (macOS 14.2+) |

The window is transparent, borderless and always on top. A background thread polls the
global cursor position and toggles `ignore_cursor_events`, so clicks pass through
everywhere except the character's own bounding box — the webview cannot do this itself,
because while the window is click-through it receives no events at all.

### TypeScript (`desktop/src/`)

| Module | Responsibility |
|---|---|
| `main.ts` | Wiring: boot, menus, settings events, status bar, hit reporting |
| `live2d.ts` | The Live2D model: loading, motions, expressions, framing, gaze, lip sync input |
| `director.ts` | Turns a semantic state into what the model should do |
| `semantic.ts` | Polls the state file, applies staleness and reaction de-duplication |
| `idle.ts` | Idle autonomy — glances and motions when nothing is happening |
| `audio.ts`, `voice.ts`, `audio-source.ts` | Loudness → mouth opening, from three possible sources |
| `manifest.ts`, `inventory.ts` | Reads `model3.json` / `avatar.json`, validates the mapping against the model |
| `pixi.ts` | Renderer-level compatibility patches, isolated in one file |
| `prefs.ts` | Config shared by the main and settings windows |

Rendering is PixiJS 8 plus `pixi-live2d-display`, on top of Live2D Cubism Core, which is
redistributed under Live2D's own license (see [THIRD-PARTY.md](THIRD-PARTY.md)).

### Why audio is not part of the protocol

Only one of the five harnesses exposes a speech stream. The other four speak through the
system audio device like any other app, and a single process tap captures all of them
with zero integration. Putting `audio.chunk` in the protocol would define a spec that
most harnesses can never implement, since they do not control TTS.

So: **semantics go through the bridge, audio goes out of band.**

## Data locations

```
~/Library/Application Support/io.github.joyparkray.agentavatar/
├── config.json      preferences, shared by both windows
└── models/          models you installed

$TMPDIR/agent-avatar-state[.<harness>].json    the state file, 0600
/tmp/agent-avatar-webview.log                  diagnostics, one JSON object per line
```

## Extending it

- **A new harness** — write a connector; see [docs/CONNECTORS.md](docs/CONNECTORS.md#adding-a-harness).
- **A new avatar runtime** — read the state file and perform it. VRM, 3D, pixel art or a
  plain status bar are all valid consumers; nothing in the protocol is Live2D-specific.
