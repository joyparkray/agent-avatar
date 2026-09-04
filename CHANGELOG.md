# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-09-04

Windows support, and the model handling needed to make third-party models work there.

### Windows

- Fixed: launching the app also opened a console window that stayed for the whole session.
  The Windows GUI subsystem was never declared — it had never been needed on macOS.

- Fixed: the connector build could ship a broken app. `build-bundle.sh` asked for `python3`,
  which on Windows is the Microsoft Store placeholder rather than an interpreter, so the build
  stopped after the first harness — but only after deleting the previous tree, leaving a partial
  one that still satisfied the app's "did you run build-bundle.sh" check. The installer built and
  packaged without complaint, and the failure only surfaced when a user pressed Install. The script
  now probes for a real Python 3 (`python`, `py`, or `AGENT_AVATAR_PYTHON`), assembles into a
  staging directory that replaces the live tree only once all five harnesses are built, and the app
  refuses an incomplete tree while naming what is missing.
- Fixed: WorkBuddy installed as a desktop app was reported as "command line program not found".
  Its CLI ships inside the app rather than on PATH, and the lookup for it was macOS-only. On
  Windows that file is a Node script with no extension, which the process API cannot launch
  directly (`The specified executable is not a valid application for this OS platform`), so it is
  now run through Node, and only offered when a Node is actually available.
- Fixed: the Hermes reachability probe failed roughly two runs in five. The request was written in
  five separate socket writes, and a server that answered and closed after the first one left the
  rest to be written to a closed socket. The whole request goes out in one write now. The test that
  covers it had been disabled on Windows and is running again.
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
- Global audio capture works on both platforms, through the API each one actually has:
  a Core Audio process tap on macOS (which can exclude the app's own output), WASAPI
  loopback on Windows. Both emit the same two events, so lip sync behaves the same either
  side; nothing in the front end knows which one is running.

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
- Fixed: the second line stayed blank for WorkBuddy in headless mode, and the avatar sat on
  "Thinking" through every tool call. WorkBuddy does not announce the start of a turn there, and
  tool events belonging to an unannounced turn were being discarded by the guard that stops
  finished turns from wedging the avatar. Tool events now register their own turn where the
  harness is known not to announce one.
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
- Fixed: uninstalling left a backup file of ours behind in dsh's configuration directory, holding
  our own block and a path that no longer existed. Backups left by earlier versions in Codex's and
  Hermes's directories are cleaned up too.

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

### Connectors

Found by running the five harnesses' own command line tools on macOS for the first time —
the install path had only ever been exercised on Windows.

- Fixed: **installing a second time corrupted the hook command line**, and Claude Code then
  refused every prompt with `A hook blocked your prompt` / `unexpected EOF while looking for
  matching "`. Localisation strips the old interpreter off the front of the command by
  splitting at the first space, and the interpreter lives under
  `~/Library/Application Support/…` — the space in "Application Support" is unavoidable. The
  first install was fine; the second one split the path in half and pasted the remainder back
  as an argument. Windows has the same shape for a different reason (its first token is
  deliberately unquoted), so both are handled: the interpreter is now split off by its quotes,
  falling back to the space only when there are none.
- Fixed: a plugin of the same name from **another marketplace** counted as ours. The check
  matched the `agent-avatar@` prefix, so an entry left by an older install
  (`agent-avatar@agent-avatar-local`) made the app say "installed" for something it could
  neither manage nor remove — uninstalling then failed with the harness's own
  `Plugin "agent-avatar@agent-avatar" is not installed in user scope`, and on Codex the
  removal reported success while the row stayed "installed". The full id is matched now.
- Fixed: **WorkBuddy was reported as not installed after installing successfully**, and its
  plugin list did not show us at all. Two causes: its command line tool ships inside the
  desktop app rather than on PATH, and it serves two products from one binary with a
  separate configuration directory each — we registered into the one the standalone CLI
  reads while the desktop app reads the other. Both directories are written now, and both
  are read back. A plugin installed from a directory marketplace also never reaches
  `installed_plugins.json`; only `settings.json` records it, and both files are consulted.
- Fixed: the "say what it is doing" switch was **turned off at every start**. The reassertion
  that keeps it alive across temp-directory cleanups read the setting before the settings
  file had loaded, so it asserted the default — the switch stayed ticked while the connector
  was told to stay quiet.
- Fixed: the second line was **too brief to read**. It only existed between a tool starting
  and finishing, which is 62–184 ms for a file read, against a 200 ms poll — measured on a
  real session. The detail now outlives the tool by a second, and each one holds the line for
  a second before the next replaces it.
- The tool's command line is shown now. It had been excluded because a command can carry an
  auth header, but that left the one tool that runs long enough to be read as the only one
  with nothing to say. File contents and replacement strings are still never shown.
- The bundled interpreter is no longer **copied three times** into the app. Its `bin/`
  directory ships two symlinks beside the real binary, and the packager followed them: 35 MB
  of duplicate on disk and 14 MB of download, for one 18 MB file stored three times.

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

### Known limitations

- **Windows builds are not code signed.** SmartScreen will warn on first run; choose "More
  info" then "Run anyway". macOS builds are signed with a Developer ID certificate and
  notarised, so a normal double-click works there.
- **Headless runs do not move the avatar** on Claude Code. `claude -p` fires no plugin hooks
  at all — measured, not inferred — so nothing reaches the connector. Interactive sessions are
  unaffected. WorkBuddy's headless mode does fire them and is handled.
- **Hermes and dsh load their plugin inside their own process.** Installing or upgrading their
  connector takes effect only after that process restarts — a new session in the same process
  keeps running the old code. The other three spawn a fresh hook per event and pick up changes
  immediately. The app says which one it is when you install.
- The second line under the state is only as good as the field names it knows. Tools whose
  arguments use a name it does not recognise show no detail; the state itself is unaffected.
- Live2D models using Cubism 5.1 offscreen compositing cannot be rendered.

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
