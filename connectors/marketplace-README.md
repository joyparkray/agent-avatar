# Agent Avatar connectors

<p align="center">
  <b>English</b> · <a href="README.zh.md">简体中文</a>
</p>

Let a desktop mascot follow along with your agent: when it is thinking, running a
tool or waiting on a subagent, the avatar changes expression.

These are the **plugins themselves**, for five agent harnesses. Version {{VERSION}}.

> **Pure observer**: they read events and write one local state file (under
> `$TMPDIR` / `%TEMP%`). They never return instructions, never block a tool and
> never take part in an approval decision. To see exactly what they do, every entry
> point is in `plugins/<harness>/agent-avatar/` — a few hundred lines of Python.

---

## You probably do not need this page

**The app installs these for you.** Open Agent Avatar → Settings → Agent, and press
Install next to your harness. It ships the plugin and a Python interpreter inside
itself, so nothing is downloaded, and it registers the plugin by calling your
harness's own CLI. If it fails, it tells you which step and what the harness said.

This page is for the cases the app cannot reach:

- your harness runs somewhere the app cannot see it — **WSL, a container, another
  machine**;
- you want to **read the commands before running them**, or repair an install by
  hand;
- you are packaging Agent Avatar for something we have not thought of.

---

## Getting the files

Clone the app repository and build the connector tree:

```
git clone https://github.com/{{REPO}} agent-avatar
cd agent-avatar
sh connectors/build-bundle.sh ./connector-tree
cd connector-tree/marketplace
```

That needs a shell and a Python — the same Python you are about to install the
connector for. The build step also **runs a smoke test per harness**, so a tree that
assembles is a tree whose core is complete.

(Every release also attaches a prebuilt `agent-avatar-connectors.zip`, if you would
rather not build it.)

---

## Installing

Three of the harnesses read a *marketplace* — a directory with a manifest. Their
manifest file names differ, so one directory serves all three. The other two are
installed differently, and each has its own section below.

### Claude Code

```
python localize.py claude-code
claude plugin marketplace add ./
claude plugin install agent-avatar@agent-avatar
```

`localize.py` writes the interpreter that is running it into the hook command line.
It is not optional on Windows, where `python3` is **not Python** — it resolves to a
0-byte Microsoft Store placeholder that starts, prints "Python was not found" and
exits with 9009. Since 9009 is not 2, no harness treats it as a failure, and the only
symptom is an avatar that never moves. On macOS it is worth running too: it pins the
interpreter instead of leaving `/usr/bin/python3`, which on a Mac without the Xcode
command line tools is a placeholder that pops an install dialog.

**Start a new session** afterwards — plugins load at session start.

### WorkBuddy / CodeBuddy Code

Same shape: `codebuddy` instead of `claude`, and `workbuddy` for `localize.py`.

🔴 **Which config directory you install into matters.** The same CLI has two homes:
**the app reads `~/.workbuddy`**, while the standalone CLI defaults to `~/.codebuddy`.
Getting it wrong is the most confusing failure of all — **everything tests fine on the
command line and the app does nothing**. If you only use the app, point
`CODEBUDDY_CONFIG_DIR` at `~/.workbuddy` before installing.

**Restart the WorkBuddy app** afterwards (plugins load at startup).

### Codex

```
python localize.py codex
codex plugin marketplace add ./
codex plugin add agent-avatar@agent-avatar
```

🔴 Codex's verbs are **`plugin add` / `plugin remove`**, not install/uninstall.

🔴 **On Windows `codex` is not on PATH, but it exists.** The ChatGPT app ships it at
`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` — the directory name is a build
hash, so take the newest one and call it by absolute path. (We spent a while believing
the Windows app had no CLI at all, and wrote a whole config-file route around that
belief. It was wrong, and worse, that route was a half-install: `codex plugin add`
also copies the plugin into `~/.codex/plugins/cache/…` and reports *that* as the
installed root, which hand-editing `config.toml` never creates.)

Two manual steps afterwards, and neither can be done for you:

1. **Fully quit and reopen the ChatGPT app** — plugins are discovered at startup.
2. **Run `/hooks` in a Codex session and trust each hook.** Enabling a plugin does
   *not* trust its hooks, and untrusted hooks are skipped silently. That is a security
   design, not a fault. Trust is keyed to the hook's **content hash**, so you must
   re-trust after every connector upgrade.

### DeepSeek Harness (dsh)

dsh has no plugin CLI at all: the registration *is* an entry in its patch file.

```
python localize.py dsh --register
```

That writes `$DSH_HOME/cordis.patch.yml` (defaults to `~/.dsh`), backing up whatever
was there first. It is idempotent — including against entries pasted in by hand
before this flag existed — and `--unregister` takes it back out. Use
`--print-registration` if you want to see the block without writing it.

The entry's `name` must be a `file:///` URL: dsh imports it as an ES module
specifier, and Node reads `C:/…` as a URL whose scheme is `c:`. The script gets this
right; a hand-written path usually does not, and the failure is silent because this
path discards the plugin's stderr.

### Hermes

Hermes installs from **git only** — a URL, `owner/repo`, or a name from its index. It
does not take a local directory, and `file://` does not support the
`owner/repo/subdirectory` form: whatever you point it at is cloned whole, so the
plugin's `plugin.yaml` has to be at that repository's **root**.

So make one. From the built tree:

```
cp -r plugins/hermes/agent-avatar /tmp/agent-avatar-hermes
cd /tmp/agent-avatar-hermes && git init -q && git add -A && git commit -qm bundled
hermes plugins install "file:///tmp/agent-avatar-hermes" --enable
hermes plugins doctor agent-avatar
```

`doctor` should say `OK: runtime discovery, manifest parsing, import, and
registration passed` and `10 hook(s)`. This is exactly what the app does, which is how
it installs Hermes without touching the network.

🔴 **Do not point Hermes at this plugin's directory in the app repository.** The
source tree there has no `state_machine.py` — the shared core is copied in at build
time — so you would install a plugin that cannot import itself.

Hermes is the only one of the five that needs no localisation — its plugin is an
in-process Python package that runs inside Hermes's own interpreter and spawns
nothing.

---

## Checking that it actually works

🔴 **Do not go by "the command did not report an error".** The hook is designed to
**always exit 0** (exit code 2 is a block in Claude Code and Codex and would stop your
agent), so its exit code proves nothing.

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

1. **No new session yet** — plugins load at session start; a session already running
   will not pick one up.
2. **A manual step is still pending** — Codex needs `/hooks` trust, WorkBuddy needs an
   app restart, Hermes needs `gateway restart`.
3. **Your antivirus deleted the files.** Kaspersky is known to classify files like
   these as `PDM:Trojan.Win32.Generic` — a behavioural false positive on "an unsigned
   script editing another application's configuration". Check its quarantine. The
   symptom is indistinguishable from a bad install: the files are simply gone.
4. **No usable Python.** On Windows `python3` is often the 0-byte placeholder
   described above. `python -c "import sys; print(sys.executable)"` tells you what you
   actually have.

## Uninstalling

Use each harness's own command, with the **qualified** plugin name:

```
claude    plugin uninstall agent-avatar@agent-avatar   &&  claude    plugin marketplace remove agent-avatar
codebuddy plugin uninstall agent-avatar@agent-avatar   &&  codebuddy plugin marketplace remove agent-avatar
codex     plugin remove    agent-avatar@agent-avatar   &&  codex     plugin marketplace remove agent-avatar
```

🔴 The short name **fails on WorkBuddy** (`Marketplace undefined is not found.`) and
leaves the plugin in place. It can look like it worked, because removing the
marketplace takes the plugin down as a side effect — until the day it doesn't.

For dsh: `python localize.py dsh --unregister`.

For Hermes, **disable before removing**:

```
hermes plugins disable agent-avatar
hermes plugins remove  agent-avatar
```

`remove` on its own leaves the entry under `plugins.enabled` in `config.yaml`, so the
list says enabled while nothing can load. And on Windows `remove` only does half the
job: it renames the directory to `.agent-avatar.remove-xxxx` and then cannot delete it
(the git pack files it cloned are read-only), so clear the read-only attribute and
delete that leftover under `%LOCALAPPDATA%\hermes\plugins\`. This is Hermes's own
Windows behaviour, not the plugin's — the app sweeps it for you.

## What is in here

```
plugins/<harness>/agent-avatar/    one tree per harness
localize.py                        writes this machine's interpreter into the hooks
.claude-plugin/  .agents/  .codebuddy-plugin/    the three marketplace manifests
```

The five trees each carry their own copy of the same core (`state_machine.py`), which
turns each harness's events into one shared vocabulary of states. The adapters differ;
the state machine does not — it is the contract with the app, and a fork there would
show up as "the avatar displays the wrong state", which nobody notices for weeks.
