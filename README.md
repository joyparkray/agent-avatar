# Agent Avatar

<p align="center">
  <img src="assets/icon.png" width="128" height="128" alt="Agent Avatar cat-eared mascot icon">
</p>

**Stop watching a terminal to find out whether your agent is working or waiting for you.**

Agent Avatar puts a Live2D character on your desktop that acts out what your AI coding
agent is doing — thinking, running a tool, waiting on you, reviewing, stuck — and
lip-syncs whenever the agent speaks.

> 中文说明见 [README.zh.md](README.zh.md)。

<p align="center">
  <img src="assets/screenshots/desktop.png" width="900" alt="Agent Avatar on a desktop next to an agent session, the status pill reading Thinking">
</p>

---

## Pick your agent. Pick your character. Neither one locks you in.

Most desktop mascots are welded to one app and one character. Agent Avatar is the layer
between the two, and **both ends are swappable**.

| Your agent | Your character |
|---|---|
| **Five harnesses work out of the box** — Claude Code, Codex, Hermes, DeepSeek Harness, WorkBuddy | **Any Live2D Cubism model** — the one you bought, drew, or downloaded free |
| **One click to connect**, from inside the app. No terminal, no scripts to find | **Install as many as you like** and switch from the right-click menu whenever you feel like it |
| **Add your own harness** — the state contract is a documented, tiny [protocol](bridge/README.md) | **Decide how it performs** — map each agent state to a motion of your model, or let its `avatar.json` decide |
| Run several agents at once; the avatar follows the most recently active, or pin it to one | Use the model's own motions, expressions and lip-sync parameters; nothing has to be authored for us |

In the middle sits one small standard — the [Bridge Protocol](bridge/README.md) — and a
single state machine shared by every connector. That is what keeps the two ends
independent: a new harness does not need a new avatar, and a new character does not need
a new connector.

### About models: why none ships with the app

**No Live2D model is bundled, deliberately.** Redistribution terms differ from model to
model, and shipping someone's character without clear permission is not fair to the
artist. So instead:

- **Don't have one yet?** The first-launch card links straight to
  [Live2D's free sample models](https://www.live2d.com/en/learn/sample/) — download,
  extract, drop the folder in. A few minutes.
- **Already have a favourite?** Use it. Any Cubism 3/4/5 model works, with no extra
  authoring for us.
- **Are you a model author willing to let Agent Avatar ship your work?** Please
  [open an issue](https://github.com/joyparkray/agent-avatar/issues) or get in touch —
  you would be credited, with the licence stated plainly.

## What you get

- **Status at a glance.** Thinking, executing, awaiting input, reviewing, syncing and
  errors each look different, plus `blocked` and `interrupted` reactions on top.
- **A face for voice agents.** Real-time lip sync from system audio, a local audio file
  or a Hermes speech stream — not tied to one voice stack.
- **Present without being in the way.** Transparent, always-on-top, and clicks pass
  through everywhere except the character's own silhouette. Full click-through mode is
  one menu item away, with a 3-second hover to make it interactive again.
- **Alive when idle.** It glances around and plays motions when nothing is happening,
  follows your cursor, and yields the instant you interact.
- **Chinese and English throughout** — interface, status bar, setup guides and errors.

## Your agent works; the avatar performs

A connector reports *what the agent is doing*; the avatar uses your model and settings
to decide *how to perform it*. They communicate through the lightweight
[Bridge Protocol](bridge/README.md), so the agent, model and motion mapping can evolve
independently.

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
| **Model Gallery** | One screen comparing every model you have installed: canvas size, how many motions and expressions, whether its `avatar.json` mapping is valid. Spot a broken model before it is on your desktop. |
| **Focus Mode** | Show just the bust instead of the whole body, for a smaller footprint. The crop ratio is yours to set. |
| **Expressions & Motions** | Play any of them from the menu. Click the avatar for a random expression, double-click for a random motion — and you choose which ones are in each pool. |
| **Idle autonomy** | After N seconds of quiet it looks around and plays motions on its own, from a *separate* pool: a yawn is fine when idle, odd as a reply. Set N to 0 to switch it off. |
| **Quality and frame rate** | Three render tiers and 30/60 FPS. Lowering quality saves more GPU than lowering frame rate, so the menu says so. |
| **Where it sits** | Always on top, snap to the bottom edge, center on screen, scale and opacity. |
| **Eyes follow the cursor** | Optional, and idle autonomy steps aside while it is on. |
| **Click Through** | The whole window stops catching clicks; hover the character for 3 seconds when you need it back. |
| **Audio Source** | System audio, an audio file, or a Hermes speech stream — whichever your setup actually produces. |
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

## Settings

Five tabs: **General** (language, status bar), **Video** (scale, opacity, focus crop,
quality, frame rate), **Agent** (connectors, and a motion for each agent state),
**Behavior** (idle autonomy and the random pools), **Models** (install, hide, delete).

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
