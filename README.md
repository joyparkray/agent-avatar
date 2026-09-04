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
  <img src="https://img.shields.io/badge/Windows-10%2B-lightgrey" alt="Windows 10+">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT licence">
</p>

<p align="center">
  <strong>Give your AI coding agent a body on your desktop.</strong>
</p>

Agent Avatar turns the **real runtime state of the coding agent you already use** into a
Live2D character you can understand at a glance.

When your agent thinks, the avatar thinks. When it runs a tool, the avatar gets busy. When
it is reviewing, stuck, or **waiting for you**, you can see that without reopening a
terminal just to check.

It is **not another chatbot with an avatar attached**. Agent Avatar does not replace your
agent or lock you into one AI. It sits beside Claude Code, Codex, Hermes, DeepSeek Harness
or WorkBuddy and gives their work a visible desktop presence.

**macOS and Windows · five agent connectors, each one click away · bring your own Live2D
character**

<p align="center">
  <a href="../../releases"><b>Download</b></a> ·
  <a href="docs/QUICKSTART.md">Quick Start</a> ·
  <a href="docs/CONNECTORS.md">Connectors</a>
</p>

<p align="center">
  <img src="assets/screenshots/desktop.png" width="900" alt="Agent Avatar on a desktop next to an agent session, the status pill reading Thinking">
</p>

---

## Why Agent Avatar is different

A normal desktop pet can be cute and interactive. An AI avatar can talk. Agent Avatar is
built around a different idea: **your existing coding agent should become visible without
becoming a different product.**

| | Typical desktop pet / standalone AI avatar | **Agent Avatar** |
|---|---|---|
| **What drives it** | Idle loops, clicks, or its own chat model | **Real events from your coding agent** |
| **What you can tell** | Mostly whether the character is active | **Thinking, tool use, waiting, reviewing, syncing, errors** |
| **Which AI** | Usually tied to one app or backend | **Claude Code, Codex, Hermes, DeepSeek Harness, WorkBuddy** |
| **Which character** | Often fixed or app-specific | **Most Live2D Cubism 3/4/5 models** |
| **Multiple agents** | Usually not the focus | **Follow the most recently active agent or pin one** |
| **Extensibility** | App-specific integration | **Small documented Bridge Protocol for new harnesses** |

The core idea is deliberately simple:

```text
Your coding agent  →  Connector  →  Agent state  →  Live2D motion / expression / status
```

The connector reports **what the agent is doing**. Your avatar decides **how that state
should look**.

---

## Know what your agent is doing without checking the terminal

| Agent state | What you see |
|---|---|
| `idle` | Idle animation, occasional autonomous glances and motions |
| `thinking` | Thinking motion + expression (`writing` / `researching` internally) |
| `executing` | Running a tool |
| `awaiting` | Waiting for your input |
| `reviewing` | Reviewing / verifying |
| `syncing` | Talking to another agent or an external service |
| `error` | Something failed |

Two reactions can layer on top: `blocked` (permission denied) and `interrupted`.

The most useful state is often the least dramatic one: **waiting for you**. Long-running
agent sessions stop disappearing into a terminal tab — you can tell from the corner of your
eye whether work is still moving or whether the next action is yours.

### Want more detail?

Turn on **Show what it is doing** in **Settings → General → Status bar** and a second line
can show the current step: the tool's own one-line description, the **file name** being
edited, the **host** being fetched, or the search term.

It never shows command lines or file contents in that status line — a command line can
carry an auth header. The feature is off by default; while it is off, the connector does
not read those detail fields at all.

---

## Connect the agent you already use

Agent Avatar ships with five connectors. Open **Settings → Agent → Connectors**, pick your
harness, and press **Install**. The connectors and a Python interpreter are **bundled
inside the app**, so nothing is downloaded and the app and its connector can never be
different versions. The app registers the plugin by calling that harness's own CLI,
verifies the result, and tells you about any final step the harness itself requires.

| Harness | Install from Agent Avatar | Final step |
|---|---|---|
| **Claude Code** | ✅ | Start a new session |
| **DeepSeek Harness** | ✅ | None — hot reload |
| **Hermes** | ✅ | Run `hermes plugins enable agent-avatar`, then restart running sessions |
| **WorkBuddy** | ✅ | Restart the app |
| **Codex** | ✅ | Quit and reopen the app, then approve the hooks once with `/hooks` |

**Those final steps are not the app being lazy.** A harness that loads plugins in-process
cannot adopt a new one without restarting, and Codex deliberately requires a human to
approve hook code before it will run. The installer names the exact command or step on the
spot, rather than leaving you with a pet that silently does nothing.

The five harnesses have nothing in common under the hood — different plugin systems,
different event names, different lifecycles. Each connector translates its own harness into
the same small state contract, so the desktop layer never has to change when a new one is
added.

### Running several agents at once?

The avatar follows whichever supported agent was most recently active, or you can pin it to
one harness from the right-click menu. With the status bar's second line enabled, it can
also show **which agent is currently speaking**.

### Using another agent?

The integration boundary is intentionally small: one local state file and a documented set
of states. See the **[Bridge Protocol](bridge/README.md)**. The five bundled adapters are
examples of how to map different harnesses into the same avatar layer — each one is under
65 lines.

---

## Bring your own character

Agent Avatar does not tie an agent to a character. **Your AI and your avatar are
independent choices.**

**No Live2D model is bundled, deliberately.** Redistribution terms differ between models,
so the app leaves the character choice to you instead of shipping somebody else's work
without clear permission.

- **No model yet?** The first-launch card links to
  [Live2D's free sample models](https://www.live2d.com/en/learn/sample/). Download one,
  extract it, and drop the folder into the app.
- **Already have a favourite?** Use it. Most Cubism 3/4/5 models load without extra
  authoring for Agent Avatar. Cubism 5.1 models using offscreen compositing are detected
  and reported instead of being rendered incorrectly.
- **Install several.** Switch models from the right-click menu without restarting; hide the
  ones you do not use.
- **Check compatibility in one place.** The Model Gallery shows model size, motions,
  expressions, and state-mapping validity before you put it on the desktop.
- **Rename cryptic model assets.** If a model ships with names such as `F1` or `2222333`,
  Agent Avatar uses any embedded names it can find and lets you rename the rest.
- **Model authors:** if you are willing to let Agent Avatar distribute your work, please
  [open an issue](https://github.com/joyparkray/agent-avatar/issues). Credit and licensing
  will be stated clearly.

<p align="center">
  <img src="assets/screenshots/desktop-zh.png" width="900" alt="The same setup with a different model and the Chinese interface">
</p>

<p align="center"><em>Same agent layer, another Live2D model, Chinese interface.</em></p>

---

## It is still an actual desktop pet

<p align="center">
  <img src="assets/screenshots/connectors-and-menu.png" width="900" alt="Settings showing all five connectors connected, next to the avatar's right-click menu">
</p>

The agent connection is what makes Agent Avatar different, but the character is meant to
feel alive even when no task is running.

- **Idle autonomy.** After a quiet stretch it can glance around and play motions on its own.
  Idle motions use a pool separate from click reactions, and cursor-following is optional.
- **Click, double-click, or hotkey reactions.** Bind any expression or motion in your model
  to a click, double-click, or **global shortcut**. Bind several items to one trigger and
  one is chosen at random.
- **Transparent and out of the way.** The avatar stays on top while clicks pass through
  outside the character. Full click-through is one menu item away; hover for 3 seconds to
  make it interactive again.
- **Real-time lip sync.** Drive the mouth from system audio, a local audio file, or a
  Hermes speech stream, so a voice-enabled agent can use the same character layer.
- **Control the footprint.** Three render tiers, 30/60 FPS, scale, opacity, and a focus crop
  for a smaller bust-style view.
- **Chinese and English throughout.** UI, status bar, setup guidance, and errors are
  available in both languages.

---

## Install

### Requirements

- **macOS 14.2 or newer**, or **Windows 10 or newer**.
- A Live2D model — **none is bundled**; see
  [Bring your own character](#bring-your-own-character).

Connectors and lip sync work on both platforms. System audio capture uses a Core Audio
process tap on macOS and WASAPI loopback on Windows; both feed the same avatar event layer.

### Download

1. Download the latest build from [Releases](../../releases):

   | Platform | File |
   |---|---|
   | macOS (Apple Silicon) | `Agent.Avatar_<version>_aarch64.dmg` |
   | Windows (x64) | `Agent.Avatar_<version>_x64-setup.exe` |

   **macOS:** open the `.dmg` and drag `Agent Avatar.app` to `/Applications`. The build is
   signed with an Apple Developer ID and notarised, so a normal double-click works. Only an
   Apple Silicon build is published; Intel Mac users can
   [build from source](CONTRIBUTING.md).

   **Windows:** run the installer. The Windows build is **not code-signed** — I do not hold
   a Windows code-signing certificate, and for a free spare-time project the yearly cost of
   one is hard to justify. SmartScreen will therefore warn on first run: **More info → Run
   anyway**. If you would rather verify the download than trust it, every asset has a
   SHA-256 digest attached by GitHub, and building from source is supported — see
   [SECURITY.md](SECURITY.md#sandboxing-and-notarisation). Uninstalling Agent Avatar also
   removes its connectors from the five supported agents.

2. Launch Agent Avatar. If no model is installed, the onboarding card links to Live2D's free
   sample models.
3. Install a model by dragging its folder onto **Settings → Models** or onto the no-model
   onboarding card. See [docs/MODELS.md](docs/MODELS.md).
4. Connect your agent in **Settings → Agent → Connectors**. See
   [docs/CONNECTORS.md](docs/CONNECTORS.md).

Or [build from source](CONTRIBUTING.md).

---

## Manual connector setup

The in-app installer is the recommended path. Manual setup is useful when your harness runs
in **WSL, a container, or another machine**, or when you want to inspect the commands before
running them.

Build the connector tree, then install it with the harness's own CLI. For example, Claude
Code:

```bash
sh connectors/build-bundle.sh ./connector-tree
cd connector-tree/marketplace
python localize.py claude-code          # pins the interpreter into the hook command
claude plugin marketplace add ./
claude plugin install agent-avatar@agent-avatar
```

Full instructions for Codex, WorkBuddy, DeepSeek Harness, Hermes and Claude Code are in
**[the connectors README](connectors/marketplace-README.md)**.

| Harness | After manual installation |
|---|---|
| Claude Code | Start a new session |
| DeepSeek Harness | Nothing — hot reload |
| Hermes | `hermes plugins enable agent-avatar`, then restart running sessions |
| WorkBuddy | Restart the app |
| Codex | Quit and reopen the app, then approve hooks with `/hooks` in a session |

Codex approval is tracked by content hash, so connector upgrades require re-approval. See
[docs/CONNECTORS.md](docs/CONNECTORS.md) for details and troubleshooting.

Then select the matching **Agent State Source** from the avatar's right-click menu.

---

## Settings

Six tabs:

- **General** — language, status bar, and what it shows
- **Video** — scale, opacity, focus crop, quality, frame rate
- **Agent** — connectors and motion mapping for each agent state
- **Behavior** — idle autonomy, triggers, and expression/motion aliases
- **Models** — install, hide, delete
- **About** — version, update check, links

---

## For developers

Agent Avatar is split into three layers so the agent side and character side stay
independent:

```text
desktop/      Live2D rendering, audio lip sync, window and menus (Tauri + Rust + TypeScript)
bridge/       Shared protocol and state machine
connectors/   One adapter per harness, plus installers
docs/         Model installation, connector setup, troubleshooting
```

The state machine lives in one place under `bridge/`. Self-contained plugin trees are
assembled from it by `connectors/assemble.sh` rather than copied by hand.

### Documentation

- [Quick Start — 10 minutes, no source checkout](docs/QUICKSTART.md)
- [Models — installing, requirements, unsupported cases](docs/MODELS.md)
- [Connectors — per-harness setup and gotchas](docs/CONNECTORS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Bridge Protocol — add another harness](bridge/README.md)
- [Architecture — how the three layers fit together](ARCHITECTURE.md)
- [Contributing — build and test](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

---

## Support

Agent Avatar is free, open source, and built in spare time. If it brightens your desk and
you would like to support the project:

- ☕ **[Buy me a coffee](https://buymeacoffee.com/joyparkray)** — small one-off tips
- 💛 **[Donate via PayPal](https://www.paypal.com/donate/?business=KP5WLPJ9TJBZL&no_recurring=0&currency_code=USD)** — any amount, any card

Filing [issues](https://github.com/joyparkray/agent-avatar/issues), sending
[PRs](https://github.com/joyparkray/agent-avatar/pulls), and starring the repo help too.
Thank you for using it. ❤️

## License

MIT — see [LICENSE](LICENSE).

Live2D Cubism Core is redistributed under Live2D's own proprietary license, and **no Live2D
model is bundled**. See [THIRD-PARTY.md](THIRD-PARTY.md).
