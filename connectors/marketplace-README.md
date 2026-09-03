# Agent Avatar connectors

<p align="center">
  <b>English</b> · <a href="README.zh.md">简体中文</a>
</p>

Let a desktop mascot follow along with your agent: when it is thinking, running a
tool or waiting on a subagent, the avatar changes expression.

This repository holds the **plugins themselves** for five agent harnesses, and is
at the same time the plugin marketplace for three of them (their manifest file
names differ, so they coexist without interfering). Version {{VERSION}}.

> **Pure observer**: these plugins read events and write one local state file
> (under `$TMPDIR` / `%TEMP%`). They never return instructions, never block a tool
> and never take part in an approval decision. To see exactly what they do, every
> entry point is in `plugins/<harness>/agent-avatar/` — a few hundred lines of Python.

---

## Installing

**Paste the section for your harness to your agent.** You are already sitting in
front of something that can run commands, and letting it do the install is faster
and less error-prone than typing it out. Every command is fixed and explicit, so
you can read them first.

(You can also just run them yourself — they are ordinary commands.)

### Claude Code

**macOS / Linux**

```
claude plugin marketplace add {{REPO}}
claude plugin install agent-avatar@agent-avatar
```

**Windows** — one extra "localise" step, because `python3` on Windows is not
Python (it is a 0-byte Microsoft Store placeholder that starts, prints "Python was
not found" and exits):

```
git clone https://github.com/{{REPO}} agent-avatar-connectors
cd agent-avatar-connectors
python localize.py claude-code
claude plugin marketplace add ./
claude plugin install agent-avatar@agent-avatar
```

**Start a new session** afterwards (or run `/reload-plugins` in a running one).

### WorkBuddy / CodeBuddy Code

Exactly the same shape as Claude Code: replace `claude` with `codebuddy` and pass
`workbuddy` to `localize.py`.

🔴 **Which config directory you install into matters.** The same CLI has two
homes: **the app reads `~/.workbuddy`**, while the standalone CLI defaults to
`~/.codebuddy`. Getting it wrong is the most confusing failure of all: **everything
tests fine on the command line and the app does nothing**. If you only use the app,
point `CODEBUDDY_CONFIG_DIR` at `~/.workbuddy` before installing.

**Restart the WorkBuddy app** afterwards (plugins load at startup).

### Codex

**macOS / Linux**

```
codex plugin marketplace add {{REPO}}
codex plugin install agent-avatar@agent-avatar
```

**Windows** — the ChatGPT app **ships no codex CLI**, so registration is manual
(the script computes the two blocks for you):

```
git clone https://github.com/{{REPO}} agent-avatar-connectors
cd agent-avatar-connectors
python localize.py codex
python localize.py codex --print-registration
```

Append the two blocks it prints to the `config.toml` it names (back it up first),
then **fully quit and reopen the ChatGPT app**.

🔴 **The last step is yours alone**: run `/hooks` inside a Codex session and trust
each Agent Avatar hook. Enabling a plugin does **not** trust its hooks, and
untrusted hooks are **skipped silently** — which looks exactly like "the plugin is
enabled but the avatar does not move". That is a security design, not a bug.
(After a connector upgrade you have to trust them again: Codex keys trust to the
hook's content hash.)

### DeepSeek Harness (dsh)

dsh has no marketplace-style install command; you add an entry to its user patch
layer instead:

```
git clone https://github.com/{{REPO}} agent-avatar-connectors
cd agent-avatar-connectors
python localize.py dsh            # Windows only
python localize.py dsh --print-registration
```

Append the block it prints to `$DSH_HOME/cordis.patch.yml` (defaults to `~/.dsh`;
back it up first). dsh watches that file with HMR — **a running dsh picks it up
without a restart**.

> On Windows that `name` **must be a `file:///` URL**: dsh imports it as an ESM
> specifier, and Node parses `C:/…` as a URL whose scheme is `c:`
> (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). The command above already computes it — do
> not assemble it by hand.

### Hermes

Hermes has its own plugin CLI (git sources only, supports subdirectories, and can
pin a commit SHA):

```
hermes plugins install {{REPO}}/plugins/hermes/agent-avatar --enable
hermes plugins doctor agent-avatar
hermes gateway restart
```

`doctor` should report `OK: runtime discovery, manifest parsing, import, and
registration passed` and `10 hook(s)`.

> ⚠️ **Its security scanner may block this plugin.** What it flags is the line
> `if executable == "sudo":` in `state_machine.py`, classified as
> `privilege_escalation`. That code is a **command-line parser**: it skips wrapper
> commands such as `env`, `sudo` and shells to find the program actually being run,
> so the avatar can say "running git" instead of "running sudo". It is pure string
> parsing and executes nothing. Whether to override (`--force`) is **your call** —
> that gate exists precisely so a human takes a look first.

Hermes is the only one of the five that needs no localisation: its plugin is an
in-process Python package that runs inside Hermes's own interpreter and spawns
nothing.

---

## Checking that it actually works

🔴 **Do not go by "the command did not report an error".** The hook is designed to
**always exit 0** (exit code 2 is a block in Claude Code and Codex and would stop
your agent), so its exit code proves nothing.

Look at the **state file**:

| | Path |
|---|---|
| Windows | `%TEMP%\agent-avatar-state.<harness>.json` |
| macOS / Linux | `$TMPDIR/agent-avatar-state.<harness>.json` (`/tmp` when `TMPDIR` is unset) |

(Hermes keeps the original unsuffixed `agent-avatar-state.json`.)

Ask the agent to do something involving a tool call; the file's `state` should walk
through:

```
idle → writing → executing → writing → idle
```

When something goes wrong there is also an `agent-avatar-diagnostic.<harness>.json`
recording the time, the version, **the interpreter it used** and the error —
"installed but nothing moves" is nine times out of ten the wrong interpreter.

## Installed but nothing happens?

In order of likelihood:

1. **No new session yet** — plugins load at session start; a session already
   running will not pick one up.
2. **A manual step is still pending** — Codex needs `/hooks` trust, WorkBuddy needs
   an app restart, Hermes needs `gateway restart`.
3. **Your antivirus deleted the files.** Kaspersky is known to classify files like
   these as `PDM:Trojan.Win32.Generic` and **remove them outright**, after which the
   symptom is exactly "installed but nothing moves". Check its quarantine.
4. **No usable Python on this machine**:
   `python -c "import sys; print(sys.executable)"`. On Windows `python3` is often
   that 0-byte Store placeholder. If you need one:
   `winget install Python.Python.3.13` (Windows) / `xcode-select --install` (macOS).

## Uninstalling

Use each harness's own command (`claude plugin uninstall agent-avatar`,
`codebuddy plugin uninstall agent-avatar`, `hermes plugins remove agent-avatar`);
for Codex delete the two blocks from `config.toml`, and for dsh delete the
`# >>> agent-avatar (managed) >>>` block from `cordis.patch.yml`.

> ⚠️ **On Windows `hermes plugins remove` only does half the job** (measured
> 2026-09-03): it renames the plugin directory to `.agent-avatar.remove-xxxx` and
> then fails to delete it (git's pack files are read-only and its delete cannot cope),
> so `plugins.enabled` in `config.yaml` still lists `agent-avatar` while the directory
> is gone — the list shows it enabled and nothing can load it. Two manual steps
> finish the job: remove that line from `plugins.enabled` in `config.yaml`, and delete
> `%LOCALAPPDATA%\hermes\plugins\.agent-avatar.remove-*` (clear the read-only
> attribute first). This is Hermes's own Windows issue, not the plugin's.

## What is in here

```
.claude-plugin/marketplace.json      Claude Code reads this one
.agents/plugins/marketplace.json     Codex reads this one
.codebuddy-plugin/marketplace.json   WorkBuddy reads this one
plugins/<harness>/agent-avatar/      the five plugin trees
localize.py                          the Windows step that pins the interpreter path
```

`localize.py` **smoke-tests itself** after rewriting: it feeds one real event
through and only succeeds if the state file actually lands.

The desktop app lives at
[joyparkray/agent-avatar](https://github.com/joyparkray/agent-avatar). Connectors
and app ship separately — changing a connector does not require reinstalling the app.

MIT.
