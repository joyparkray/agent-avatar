# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Windows support, and the model handling needed to make third-party models work there.

### Windows

- Fixed: launching the app also opened a console window that stayed for the whole session.
  The Windows GUI subsystem was never declared — it had never been needed on macOS.

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

### The avatar

- **The status bar can say what the agent is actually doing.** A second line under the
  state names the current step — the tool's own one-line description ("Run the test suite"),
  the file name it is editing, the host it is fetching, the term it is searching. Off by
  default; Settings → Status bar. The data was always in the event the connector already
  receives, so nothing new is read from your machine — but with the switch off the
  connector does not touch those fields at all, and nothing about the tool is written to
  the state file. A command line, file contents and replacement strings are never taken:
  a command line can carry an auth header. Measured on real transcripts before building
  it: a Bash description was present in 1567 of 1567 calls, median 32 characters.
- Both lines keep their place. The pill is bottom-anchored, so a second line would have
  pushed the state up every time it appeared; the box is a fixed size while the detail is
  on, and the first line never moves. The first line no longer wraps either — wrapping
  would have moved it just the same.
- **Rename the states.** `writing` and `researching` both read "Thinking" out of the box,
  which is deliberate — a tool that flashes past should not make the label flicker — but
  it also hid which one was happening. Every state now takes a name of your own ("生气中"
  for error, whatever you like), and the settings row shows both the current wording and
  the internal state so two rows that read alike are still tellable apart. The name is
  stored once, not per language: it is what you called your character, not a string to be
  translated back.
- **State mapping covers expressions, not just motions.** The runtime always played a
  motion *and* set an expression for each state; only the motion was configurable, so the
  expression could only come from whatever the model author wrote in `avatar.json`. Both
  are pickable now, grouped by the author's categories and labelled with your aliases.
- **An About page** — Settings → About: the app icon, the author, copyright, the version,
  the repository, and the third-party components with their licences (Live2D Cubism Core
  is proprietary and its EULA asks for exactly this).
- Fixed: the first-run card was taller than the window and got clipped — half the drop
  zone and all of the download button were off-screen, with no scrollbar to say so. The
  window now sizes itself to the card, measured rather than hardcoded, because the
  Chinese and English wordings differ in height.
- Removing every connector at once now asks twice.

- **Expressions and motions are one table now**, with a trigger per entry: click,
  double-click, or a **global shortcut**. The avatar is always on top and usually
  click-through, so it almost never holds focus and in-app keys never reach it; shortcuts
  are registered with the OS and work while you are in another window. Bind several
  entries to the same trigger and it picks among them at random, exactly as click and
  double-click already did. A shortcut must include Ctrl/Alt/Shift — a bare key would fire
  while you type in any application — and one the system refuses is reported on that row,
  never silently dropped.
- **Aliases.** Third-party models name things `F1`, `Q` or `2222333`, which tells you
  nothing about what they do. Most authors did name them, in `.cdi3.json` or
  `.vtube.json`; those names are now read on import and filled in for you (boy8 gets all
  20: 兽耳, 生气, 星星…). Rename any of them; the name is display only, so playback,
  state mapping and the random pools are unaffected.
- **Keep on.** Most of what third-party models call expressions are single-parameter
  switches — cat ears, a hood, a drink in the hand, a symbol over the head — and those can
  be held indefinitely and combined freely. Tick as many as you like: cat ears and a drink
  and an angry mark all show at once. No exclusivity is enforced, because there is none to
  detect: the parameters are independent and all render together. Two props do overlap in
  the same hand, but that is a matter of taste, and nothing in the model records which
  entries share a body part — guessing would also forbid the combinations that do work
  (hiding head, body and ears together). Entries that change several parameters at once
  cannot be held: those go through the expression manager, which shows one at a time.
- The table is grouped by the author's own categories from `.cdi3.json` — boy8 arrives
  sorted into 隐藏 / 表情 / 动作 — with everything else under one heading rather than an
  invented taxonomy.
- **Lip sync no longer starts by itself.** The audio source defaulted to system audio, so
  the app opened a loopback capture the moment it launched and antivirus software
  reasonably announced that this program was recording audio — before the user had asked
  for anything. The default is now off; pick a source in Settings → Behaviour and capture
  starts then. An existing choice is untouched.
- Appearance switches are no longer bound to click by default. They are state, not a
  reaction, and putting them in the random click pool meant clicking the character could
  hide its head. Real expressions still default to click and motions to double-click, so
  the character still responds out of the box.
- Fixed: the **Idle** column in Settings was written to the config but never read. Idle
  autonomy was actually drawing from the double-click pool, so turning entries off for
  idle did nothing. It now uses the column you set.

### Uninstalling

- The uninstaller asked whether to delete your data **on top of** the installer's own
  "delete application data" checkbox. It now reads that checkbox instead of asking again.
- **Uninstalling with your data kept now keeps your connectors too.** Uninstalling has to
  take the registrations back — those hooks point at an interpreter that is about to
  disappear — but "keep my data" that still made you re-connect five harnesses by hand was
  not keeping much. The harnesses you had connected are written down, and reinstalling
  puts them back. (The note is written by the uninstaller of the version being removed, so
  the first upgrade into this behaviour cannot benefit from it.)
- Upgrading no longer takes the connectors back at all. The installer runs the old
  uninstaller with `/UPDATE` on the way through, and the hook did not check for it — every
  upgrade disconnected all five harnesses.

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
