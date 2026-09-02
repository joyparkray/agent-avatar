# Agent Avatar

<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="Agent Avatar cat-eared mascot icon">
</p>

<p align="center">
  <b>English</b> · <a href="README.zh.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/joyparkray/agent-avatar/actions/workflows/ci.yml"><img src="https://github.com/joyparkray/agent-avatar/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/macOS-14.2%2B-lightgrey" alt="macOS 14.2+">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT licence">
</p>

**Stop watching a terminal to find out whether your agent is working or waiting for you.**

Agent Avatar puts a Live2D character on your desktop that acts out what your AI coding
agent is doing — thinking, running a tool, waiting on you, reviewing, stuck — and
lip-syncs whenever the agent speaks.

**macOS 14.2 or newer. Windows is what comes next.**

<p align="center">
  <img src="assets/screenshots/desktop.png" width="900" alt="Agent Avatar on a desktop next to an agent session, the status pill reading Thinking">
</p>

---

## Pick your agent. Pick your character. Neither one locks you in.

A desktop character usually comes tied to one app and one look. Agent Avatar is the layer
in between, and **both ends stay yours to choose**.

| Your agent | Your character |
|---|---|
| **Five connectors are built in** — Claude Code, Codex, Hermes, DeepSeek Harness, WorkBuddy | **Most Live2D Cubism 3/4/5 models** — bought, drawn, or downloaded free |
| **Install one in a click** from inside the app; no terminal. A couple of harnesses need one more step of their own, and the wizard tells you which | **Install as many as you like** and switch from the right-click menu, mid-session |
| **Add your own harness** — the state contract is a small, documented [protocol](bridge/README.md) | **Loads without any authoring for us**; to give each agent state its own motion, map them in Settings (or ship an `avatar.json`) |
| Run several agents at once: follow whichever is active, or pin the avatar to one | Models using Cubism 5.1 offscreen compositing are the exception — they are detected and reported, not drawn wrong |

In the middle sits one small standard — the [Bridge Protocol](bridge/README.md) — and a
single state machine shared by every connector. That is what keeps the two ends
independent: a new harness does not need a new avatar, and a new character does not need
a new connector.

### About models: why none ships with the app

**No Live2D model is bundled, deliberately.** Redistribution terms differ from model to
model, and shipping someone's character without clear permission is not fair to the
artist. So instead:

- **Don't have one yet?** The first-launch card links straight to
  [Live2D's free sample models](https://www.live2d.com/en/learn/sample/): download,
  extract, drop the folder in.
- **Already have a favourite?** Use it. Most Cubism 3/4/5 models load with no extra
  authoring — the exception is Cubism 5.1 offscreen compositing, which the app detects
  and reports instead of drawing incorrectly.
- **Are you a model author willing to let Agent Avatar ship your work?** Please
  [open an issue](https://github.com/joyparkray/agent-avatar/issues) or get in touch —
  you would be credited, with the licence stated plainly.

## What you get

- **Stop tabbing back to check.** Whether the run is moving or waiting on you is visible
  from across the desk — the full state table is below.
- **A face for voice agents.** Real-time lip sync from system audio, a local audio file
  or a Hermes speech stream — not tied to one voice stack.
- **Present without being in the way.** Transparent, always-on-top, and clicks pass
  through outside the character's bounding box. Full click-through mode is
  one menu item away, with a 3-second hover to make it interactive again.
- **Alive when idle.** It glances around and plays motions when nothing is happening,
  follows your cursor, and yields the instant you interact.
- **Chinese and English throughout** — interface, status bar, setup guides and errors.

## Your agent works; the avatar performs

A connector reports *what the agent is doing*; the avatar decides *how to perform it*
using your model and your settings.

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

---

## Everything is a right-click away

<p align="center">
  <img src="assets/screenshots/connectors-and-menu.png" width="900" alt="Settings showing all five connectors connected, next to the avatar's right-click menu">
</p>

| | |
|---|---|
| **Swap characters** | Every installed model is in the menu — switch mid-session, no restart. Hide the ones you are not using. |
| **Model Gallery** | One screen comparing every installed model — size, motions, expressions, mapping validity — so you catch a problem before the model is on your desktop. |
| **Focus Mode** | Show just the bust instead of the whole body, for a smaller footprint. The crop ratio is yours to set. |
| **Expressions & Motions** | One table, one trigger per entry: click, double-click, or a **global shortcut** that works while the avatar has no focus. Bind several entries to the same trigger and it picks among them at random. |
| **Aliases** | Third-party models name things `F1` or `2222333`. Whatever the author did name is filled in for you; rename anything you like. |
| **Idle autonomy** | It comes alive on its own after a quiet stretch, from a pool kept separate from the click pool — a yawn suits idling, not a reply. Off with one field. |
| **Quality and frame rate** | Three render tiers and 30/60 FPS, so an always-on character costs what you are willing to spend on it. |
| **Where it sits** | Always on top, snap to the bottom edge, center on screen, scale and opacity. |
| **Eyes follow the cursor** | Optional, and idle autonomy steps aside while it is on. |
| **Click Through** | The whole window stops catching clicks; hover the character for 3 seconds when you need it back. |
| **Audio Source** | Off until you choose: system audio, an audio file, or a Hermes speech stream — whichever your setup actually produces. Nothing is captured before you pick one. |
| **Agent State Source** | Follow whichever agent is most recently active, or pin the avatar to one harness. |

<p align="center">
  <img src="assets/screenshots/desktop-zh.png" width="900" alt="The same setup with a different model and the Chinese interface">
</p>

<p align="center"><em>Same app, another model, Chinese interface — both are one menu away.</em></p>

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
3. Install a model — drag its folder onto **Settings → Models**, or onto the card the app
   shows when no model is installed yet. See [docs/MODELS.md](docs/MODELS.md).
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

## Settings

Five tabs: **General** (language, status bar), **Video** (scale, opacity, focus crop,
quality, frame rate), **Agent** (connectors, and a motion for each agent state),
**Behavior** (idle autonomy, triggers and aliases for expressions and motions), **Models** (install, hide, delete).

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
