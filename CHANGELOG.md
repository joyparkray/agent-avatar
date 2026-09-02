# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Windows support, and the model handling needed to make third-party models work there.

### Windows

- Runs on Windows 10 and later. The transparent, always-on-top window and hardware
  accelerated Live2D rendering coexist on WebView2 — verified on real hardware, not CI,
  which has no GPU.
- Ships as an NSIS installer and as a no-install zip (`npm run pack:portable`).
- CI now runs the four suites on `windows-latest` as well as `macos-latest`, and builds
  the installer.
- Diagnostics, the state file and the HTTP log follow the platform temp directory instead
  of a hardcoded `/tmp`.
- The bridge takes a real cross-process lock on Windows. It previously fell back to
  writing without one, so concurrent hooks — parallel tool calls, subagents — could
  overwrite each other's bookkeeping and leave the avatar stuck in the wrong state.
- Opening the model folder and external links use the platform file manager and browser.
- Global audio capture is still macOS only; on Windows the app degrades to no lip sync
  instead of failing to start.

### Models

- **Models without motions load.** Models made for face tracking commonly ship
  expressions only; these were rejected outright with "model3 has no motions". They now
  load and animate through blinking, breathing, physics and gaze.
- **Imported models are tidied up.** Folder names with spaces are normalised instead of
  refused, and expressions and motions present on disk but missing from `model3.json` are
  registered — additively, never altering what the author declared, with the original
  kept as `.orig`. See [docs/MODELS.md](docs/MODELS.md).
- The first-run card is now itself a drop target: drag a model folder onto it and the app
  installs and loads it, instead of sending you to Settings and back.
- **Removed: "Open Models Folder"**, from both the right-click menu and Settings. A model
  copied in by hand skips the import step above, and most third-party models do not work
  without it, so the entry was teaching a route that produces broken models. Installing is
  now the drop zone only. The directory path is in
  [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for when you need to look.

### Fixed

- The built-in file server rejected any URL containing a percent escape, so models whose
  file names contain spaces or non-ASCII characters could be installed but never loaded.
  Escapes are now decoded before the path checks rather than being treated as suspect.

## [1.0.0] — 2026-08-29

First public release.

### The avatar

- Live2D character in a transparent, always-on-top desktop window; clicks pass through
  everywhere except the character's own silhouette.
- Performs the agent's state: idle, thinking, executing, awaiting, reviewing, syncing and
  error, plus `blocked` and `interrupted` reactions.
- Lip sync from system audio, an audio file, or a Hermes speech stream.
- Click for an expression, double-click for a motion, from pools you choose.
- Idle autonomy: looks around and plays motions when nothing is happening, and yields the
  moment you interact.
- Eyes follow the cursor, click-through mode with a 3-second hover to interact, focus
  crop, snap to bottom, scale, opacity, render quality and frame rate.
- Chinese and English interface, including the status bar.

### Models

- No model is bundled; install your own by dropping a folder into Settings, with clear
  reasons when a folder cannot be used.
- Works with Cubism 3 through 5 models (Cubism Core 6.0.1). Models using Cubism 5.1
  offscreen compositing are detected and reported as unsupported instead of being drawn
  incorrectly.
- Map each agent state to a motion of your model in Settings, or ship an `avatar.json`
  with the model.
- Model gallery for comparing installed models and spotting mapping problems.

### Harnesses

- Connectors for Claude Code, Codex, Hermes, DeepSeek Harness and WorkBuddy, each
  verified on real sessions, sharing a single state machine through the Bridge Protocol.
- **One-click setup from inside the app.** A first-run wizard (and Settings → Agent →
  Connectors) downloads the connector bundle, extracts it and runs the harness's own
  install script — no terminal, no zip to find. Install, reinstall and uninstall are all
  in the UI.
- Each harness shows one of three states: plugin not installed, installed but needing
  manual setup, or connected and working — the middle one being the case where the files
  are in place but the harness has not enabled, trusted or reloaded the plugin yet.
- The manual steps an app cannot take for you (Hermes `plugins enable`, Codex `/hooks`
  trust, WorkBuddy restart) are spelled out per harness, in Chinese and English.

### Known limitations

- macOS only; Windows support is not started.
- Builds are signed with a Developer ID certificate (hardened runtime, timestamped) and
  notarised, so a normal double-click works.
- Live2D models using Cubism 5.1 offscreen compositing cannot be rendered.
