# Agent Avatar

<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="Agent Avatar cat-eared mascot icon">
</p>

A Live2D character that lives on your desktop and **acts out what your AI coding agent
is doing** — thinking, running a command, waiting for you, hitting an error — and moves
its mouth when the agent speaks.

Works with five agent harnesses today: **Claude Code, Codex, Hermes, DeepSeek Harness,
and WorkBuddy**.

> 中文说明见 [README.zh.md](README.zh.md)。

---

## What it actually does

The harness publishes *what it is doing*; the avatar decides *how to perform it*. Those
two halves talk through one small contract, the [Bridge Protocol](bridge/README.md), so
neither side needs to know anything about the other.

| Agent state | What you see |
|---|---|
| `idle` | Idle animation, occasional autonomous glances and motions |
| `thinking` | Thinking motion + expression (`writing` / `researching` internally) |
| `executing` | Running a tool |
| `awaiting` | Waiting for your input |
| `reviewing` | Reviewing / verifying |
| `syncing` | Talking to another agent or an external service |
| `error` | Something failed |

Plus two reactions layered on top: `blocked` (permission denied) and `interrupted`.

Other things it does:

- **Lip sync** from the system audio, an audio file, or a Hermes speech stream — so it
  moves its mouth for any agent that talks.
- **Click** for a random expression, **double-click** for a random motion. You choose
  which ones are in the pool.
- **Idle autonomy**: after a configurable idle time it looks around and plays motions on
  its own, and stops the moment you interact.
- **Eyes follow the cursor**, optionally, even outside the window.
- **Click-through mode** for keeping it on screen without it ever getting in the way
  (hover 3 seconds over the character to interact again).
- Always-on-top, snap-to-bottom, focus crop, scale, opacity, render quality and frame rate.
- Chinese and English UI.

---

## Requirements

- **macOS 14.2 or newer** (the system-audio capture path uses Core Audio process taps).
- A Live2D model — **none is bundled**, see below.
- Windows is not supported yet — it is what comes next.

## Install

1. Pick the build for your chip and download it from the [Releases](../../releases) page, then
   move `Agent Avatar.app` to `/Applications`:

   | Your Mac | File |
   |---|---|
   | Apple Silicon (M1/M2/M3/M4) | `Agent-Avatar-1.0.0-Apple-Silicon.dmg` |
   | Intel | `Agent-Avatar-1.0.0-Intel.dmg` |

   Signed with an Apple Developer ID and notarised, so **a normal double-click works** —
   no right-click → Open needed.
2. Launch it. With no model installed you get a short onboarding card with a link to
   Live2D's free sample models.
3. Install a model — drag its folder into **Settings → Models**, or drop it in the
   models folder the card opens for you. See [docs/MODELS.md](docs/MODELS.md).
4. Connect your agent — see [docs/CONNECTORS.md](docs/CONNECTORS.md).

Or [build from source](CONTRIBUTING.md).

## Connect your agent

**The easy way is one click inside the app**: Settings → Agent → Connectors, pick the
harness you use and press Install. The app downloads the bundle, extracts it, runs that
harness's install script and then shows whatever step it cannot take for you. The same
wizard opens by itself the first time you get a model running.

What follows is the manual route (offline, or if you want to read the script first). Each
connector is a plugin for its harness that reports agent state to the avatar.
Installation takes one script; what you have to do *after* installing differs per
harness, and skipping that step is the most common reason nothing happens:

| Harness | Install | After installing |
|---|---|---|
| Claude Code | `connectors/claude-code/install-plugin.sh` | nothing |
| DeepSeek Harness | `connectors/dsh/install-plugin.sh` | nothing (hot reload) |
| Hermes | `connectors/hermes/install-plugin.sh` | `plugins enable agent-avatar` |
| WorkBuddy | `connectors/workbuddy/install-plugin.sh` | **restart the app** |
| Codex | `connectors/codex/install-plugin.sh` | **approve the hooks with `/hooks` in a session** |

Codex is the one that bites: the plugin shows up as installed and enabled while its
hooks are silently skipped until you approve them, and approval is tracked by content
hash — so every connector upgrade needs re-approval. Details and troubleshooting:
[docs/CONNECTORS.md](docs/CONNECTORS.md).

Then pick the matching **Agent State Source** in the avatar's right-click menu.

---

## Right-click menu

Models · Motions · Expressions · Audio Source · Agent State Source · Always on Top ·
Snap to Bottom · Focus Mode · Eyes Follow Cursor · Click Through · Center on Screen ·
Settings… · Quit

**Settings** has five tabs: General (language, status bar), Video (scale, opacity, focus
crop, quality, frame rate), Agent (map each agent state to a motion of your model),
Behavior (idle autonomy and the random pools) and Models (install, hide, delete).

---

## Project layout

```
desktop/      The macOS app: Live2D rendering, audio lip sync, window and menus (Tauri + Rust + TypeScript)
bridge/       The protocol and the state machine both sides share — the reusable part
connectors/   One adapter per harness, plus the installers
docs/         Model installation, connectors, troubleshooting
```

The state machine lives in exactly one place (`bridge/`); self-contained plugin trees
are assembled from it by `connectors/assemble.sh`, never copied by hand.

## Docs

- [Quick Start — 10 minutes, no source checkout](docs/QUICKSTART.md)
- [Models — installing, requirements, what is not supported](docs/MODELS.md)
- [Connectors — per-harness setup and gotchas](docs/CONNECTORS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Bridge Protocol — the contract, if you want to add a harness](bridge/README.md)
- [Architecture — how the three parts fit together](ARCHITECTURE.md)
- [Contributing — build and test](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Support

Agent Avatar is free, open source and built in spare time. If it brightens your desk and
you'd like to say thanks, you can:

- ☕ **[Buy me a coffee](https://buymeacoffee.com/joyparkray)** — small one-off tips
- 💛 **[Donate via PayPal](https://www.paypal.com/donate/?business=KP5WLPJ9TJBZL&no_recurring=0&currency_code=USD)** — any amount, any card

Filing [issues](https://github.com/joyparkray/agent-avatar/issues), sending
[PRs](https://github.com/joyparkray/agent-avatar/pulls) and starring the repo count as
support too. Thank you for using it. ❤️

## License

MIT — see [LICENSE](LICENSE).

Live2D Cubism Core is redistributed under Live2D's own proprietary license, and **no
Live2D model is bundled**. See [THIRD-PARTY.md](THIRD-PARTY.md).
