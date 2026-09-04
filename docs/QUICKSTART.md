# Quick Start — getting it to react to your agent in 10 minutes

This is the "I downloaded the app and want it to work now" path. It assumes you have
**not** cloned the source — you just grabbed the installer. Everything below is doable
from the app plus one small download.

> Building from source instead? See [CONTRIBUTING.md](../CONTRIBUTING.md).

## 1. Install & launch

1. Download the build for your platform from the [Releases](../../releases) page:
   - macOS (Apple Silicon): `Agent.Avatar_<version>_aarch64.dmg`
   - Windows (x64): `Agent.Avatar_<version>_x64-setup.exe`
2. **macOS**: open the `.dmg`, drag `Agent Avatar.app` into `Applications`, then
   double-click it — the build is signed with an Apple Developer ID and notarised, so
   Gatekeeper lets it through. Only an Apple Silicon build is published; on an Intel Mac,
   [build from source](../CONTRIBUTING.md).
3. **Windows**: run the installer. It is not code-signed, so SmartScreen warns on first
   run — **More info → Run anyway**. See [SECURITY.md](../SECURITY.md#sandboxing-and-notarisation).
4. Launch it. A card appears asking for a model — you need one to see the character at all.

## 2. Get a model

No model ships with the app. Download a **free Live2D sample model**, extract the folder,
then drag that folder onto **Settings → Models** (or onto the card the app shows when no
model is installed yet). Details: [MODELS.md](MODELS.md).

## 3. Wire up your agent (the easy way)

The avatar only moves when it knows what your agent is doing. That needs a small
**connector** — a plugin for your agent harness. There are two ways to install one:

### Way A — one click inside the app (recommended for everyone, no terminal)

Once a model is installed and the avatar appears, a **setup wizard** opens by itself.
If you dismissed it, right-click the avatar → **Settings → Agent → Connectors** is the
same screen.

1. Find the harness you use (Claude Code / Codex / Hermes / DeepSeek / WorkBuddy).
2. Click **Install**. The connectors and a Python interpreter ship inside the app, so
   nothing is downloaded — it installs the right adapter and registers it by calling that
   harness's own CLI, showing each step as it goes.
3. When it finishes, the row shows **what you still need to do** (some harnesses need
   nothing — see the table below).

Every row also has a **Setup guide** button, so you can read what a harness will ask of
you before installing it. Each row shows one of three states: `Plugin not installed`,
`Installed — needs manual setup`, `Connected and working`. The middle one means the files
are in place but the harness has not enabled, trusted or reloaded the plugin yet — the
most common place to get stuck.

4. **Do the per-harness step after installing** — this is where most "it does nothing"
   reports come from:

   | Harness | After installing |
   |---|---|
   | Claude Code | nothing — already trusted |
   | DeepSeek Harness | nothing — hot reload |
   | Hermes | `hermes plugins enable agent-avatar` |
   | WorkBuddy | **restart the app** |
   | Codex | **run `/hooks` in a Codex session and approve each entry** |

### Way B — from source (for developers who clone the repo)

Follow [the connectors README](../connectors/marketplace-README.md) — the same commands
the app runs, written out. Use it when the app cannot reach your harness (WSL, a
container, another machine) or when you want to read them first.

## 4. Tell the avatar which agent

Right-click the character → **Agent State Source** → pick your harness (or *Auto*). If
it's been installed correctly, the character now acts out `thinking` / `executing` /
`waiting` / `error` and moves its mouth when the agent talks.

## Troubleshooting

It installed but nothing happens? Almost always the *after-installing* step was skipped
(especially Codex's `/hooks` and WorkBuddy's restart). See [CONNECTORS.md](CONNECTORS.md)
and [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
