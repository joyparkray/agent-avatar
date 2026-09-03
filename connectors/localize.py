#!/usr/bin/env python3
"""Localise the plugin tree to this machine — the one extra step Windows needs.

Why this step exists (Windows only)
-----------------------------------
A plugin cloned from the marketplace is the same for everybody, and it says
`python3`. On POSIX that is correct and the plugin works as-is.
**On Windows `python3` is not Python** — it resolves to
`%LOCALAPPDATA%\\Microsoft\\WindowsApps\\python3.exe`, a 0-byte Microsoft Store
stub: it starts, prints "Python was not found" and exits with 9009. And 9009 is
not 2, so the harness does not treat it as a block — **nothing anywhere notices**,
and the only symptom is an avatar that never moves.

So the interpreter has to be replaced with an absolute path that really runs on
this machine.

Why a command instead of letting the agent hand-edit JSON
---------------------------------------------------------
Installing the connector is the agent's job (the user is already sitting in front
of something that can run commands), but **the config edit has to be
deterministic**: prompts get copied, forwarded and rewritten, and only when a
prompt degrades into "run this exact command" can the user and we both be sure
what it did. A model editing JSON by hand produces a slightly different result
every time — and mistakes on this path are silent.

Where the interpreter comes from
--------------------------------
`sys.executable` — **whatever interpreter is able to run this script is, by
definition, a working interpreter.** No probing needed, and the Store stub cannot
sneak in (it cannot run this script in the first place).

Usage
-----
    python localize.py <harness> [--root <plugin tree root>]

`--root` defaults to `plugins/<harness>/agent-avatar` next to this script, which
is the layout of the published tree.
"""

import argparse
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

HARNESSES = ("claude-code", "codex", "workbuddy", "dsh", "hermes")

# Entry point and state-file name per harness. Change the layout and this table has
# to follow, otherwise the symptom is "installed, but nothing happens".
LAYOUT = {
    "claude-code": {"config": "hooks/hooks.json", "hook": "hooks/agent-avatar-hook.py",
                    "state": "agent-avatar-state.claude-code.json", "event": "UserPromptSubmit"},
    "codex": {"config": "hooks.json", "hook": "scripts/agent-avatar-hook.py",
              "state": "agent-avatar-state.codex.json", "event": "UserPromptSubmit"},
    "workbuddy": {"config": "hooks/hooks.json", "hook": "hooks/agent-avatar-hook.py",
                  "state": "agent-avatar-state.workbuddy.json", "event": "UserPromptSubmit"},
    "dsh": {"config": "index.mjs", "hook": "agent-avatar-hook.py",
            "state": "agent-avatar-state.dsh.json", "event": "pre_llm_call"},
    "hermes": {"config": None, "hook": None, "state": None, "event": None},
}


def hook_path(executable):
    """Turn an interpreter path into a shape that **works on a command line**.

    Forward slashes: the Windows API accepts either separator, but Claude Code
    defaults to Git Bash on Windows, and bash eats backslashes as escapes
    (`C:\\Python314\\python.exe` becomes `C:Python314python.exe`).

    No spaces allowed: the interpreter part of the command line cannot be quoted
    (PowerShell treats a quoted **first token** as a string expression and errors
    out), so a path containing spaces cannot be expressed at all. The default
    "install for all users" location `C:\\Program Files\\PythonXXX\\` has spaces —
    for that case we switch to the 8.3 short path, which has none and is understood
    by both shells.
    """
    path = executable
    if " " in path and os.name == "nt":
        import ctypes
        buffer = ctypes.create_unicode_buffer(512)
        if ctypes.windll.kernel32.GetShortPathNameW(path, buffer, len(buffer)) and " " not in buffer.value:
            path = buffer.value
    return path.replace("\\", "/")


def rewrite_hooks_json(path, python, harness):
    """Replace the interpreter in every command in hooks.json.

    The line we write has strict shape requirements, each one measured (see
    private/WINDOWS-PORT.md §4.6):

        C:/Python314/python.exe "${CLAUDE_PLUGIN_ROOT}/hooks/agent-avatar-hook.py" ; exit 0
        └─ forward slashes, unquoted   └─ argument quoted (both shells accept)  └─ the safety net

    `; exit 0` is not optional: if the script path ever breaks, `python x.py` exits
    with **exactly 2**, and 2 is a block in both Claude Code and Codex.

    Codex has its own `commandWindows` override field, so on Windows we write that and
    leave the POSIX `command` untouched — one hooks.json serves both platforms.
    **On POSIX we must write `command` instead.** Always writing `commandWindows` would
    put the good path in a field macOS never reads while leaving the active command as
    `/usr/bin/python3` — which on a Mac without the Xcode command line tools is a
    placeholder that pops an install dialog rather than running Python.
    """
    field = "commandWindows" if (harness == "codex" and os.name == "nt") else "command"
    with open(path, encoding="utf-8") as handle:
        document = json.load(handle)
    rewritten = 0
    for matchers in document.get("hooks", {}).values():
        for matcher in matchers:
            for hook in matcher.get("hooks", []):
                if hook.get("type") != "command":
                    continue
                source = hook.get(field) or hook.get("command", "")
                # Only the interpreter changes; the script path is kept verbatim
                # (including placeholders such as ${PLUGIN_ROOT})
                tail = source.split(None, 1)[1] if " " in source.strip() else source
                if not tail.lstrip().startswith('"'):
                    parts = tail.strip().split(" ", 1)
                    tail = '"%s"%s' % (parts[0], (" " + parts[1]) if len(parts) > 1 else "")
                hook[field] = "%s %s" % (python, tail.strip())
                rewritten += 1
    if not rewritten:
        raise SystemExit("no command found in hooks.json; the layout may have changed: %s" % path)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
    return rewritten


def rewrite_index_mjs(path, python):
    """dsh is an in-process JS plugin that spawns a python subprocess itself.

    On Windows this is the **quietest** of the five failure modes: stderr is
    `ignore`d and the `error` event only fires when the spawn itself fails — while
    the Store stub starts perfectly well. We rewrite the default on that one line;
    the `AGENT_AVATAR_PYTHON` environment variable still wins over it.
    """
    import re
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    pattern = r'process\.env\.AGENT_AVATAR_PYTHON \|\| "[^"]*"'
    if not re.search(pattern, text):
        raise SystemExit("could not find the interpreter line in index.mjs; the layout may have changed: %s" % path)
    text = re.sub(pattern, 'process.env.AGENT_AVATAR_PYTHON || "%s"' % python, text)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return 1


def smoke_test(root, harness):
    """Feed one real event through and check that the state file lands.

    **Landing is the only acceptable proof**, never the exit code: the hook is
    designed to always exit 0 (exit code 2 would block the agent), so its exit code
    says nothing about whether it did any work. A missing core module or a wrong
    interpreter both look like "nothing happened, quietly" — every trap this
    project has hit has that same shape.
    """
    layout = LAYOUT[harness]
    if not layout["hook"]:
        return None
    scratch = tempfile.mkdtemp(prefix="agent-avatar-localize-")
    environment = dict(os.environ, TMPDIR=scratch, TEMP=scratch, TMP=scratch,
                       PYTHONDONTWRITEBYTECODE="1")
    event = json.dumps({"hook_event_name": layout["event"], "session_id": "localize", "turn_id": "1"})
    subprocess.run([sys.executable, os.path.join(root, layout["hook"])],
                   input=event.encode("utf-8"), env=environment,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    landed = os.path.isfile(os.path.join(scratch, layout["state"]))
    import shutil
    shutil.rmtree(scratch, ignore_errors=True)
    if not landed:
        raise SystemExit("smoke test failed: the %s hook wrote no state file; the core may be incomplete" % harness)
    return layout["state"]


def record_install(harness, root, python, smoke_state):
    """Leave a record of **what was verified**, next to the state file.

    Why this exists: the app can already learn *that* a plugin is installed from the
    harness's own ledger, which is more trustworthy than anything we could claim
    about ourselves. What the ledger cannot answer is whether the hook actually
    *runs* on this machine — and that is exactly what the smoke test above just
    established. So this file records the verification, not a claim of installation.

    It closes a real gap in the middle state. "Installed but has never reported" is
    normal for the first few minutes (no session has started yet) and a symptom after
    a day. With this record the app can tell those two apart, and say "installed and
    self-tested at T, waiting for your first session" instead of listing five things
    that might be wrong.

    🔴 Never raises. This runs after a successful install; failing to write a note
    about it must not turn a good install into an error.
    """
    try:
        record = {
            "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "harness": harness,
            "connector_version": connector_version(root),
            "python": python,
            # The honest field: what we actually proved, not "it is installed"
            "smoke_test": "passed" if smoke_state else "skipped",
            "source": os.path.abspath(root),
        }
        path = os.path.join(tempfile.gettempdir(), "agent-avatar-install.%s.json" % harness)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, sort_keys=True)
        return path
    except Exception:                      # noqa: BLE001 - see the docstring
        return None


def connector_version(root):
    """Read the version out of the plugin tree we just localised.

    Taken from the tree rather than hardcoded here: this script and the plugin can be
    updated independently, and a version we made up would be worse than none.
    """
    for relative in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json",
                     ".codebuddy-plugin/plugin.json"):
        path = os.path.join(root, relative)
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as handle:
                    return json.load(handle).get("version")
            except (OSError, ValueError):
                return None
    path = os.path.join(root, "plugin.yaml")
    if os.path.isfile(path):
        for line in io.open(path, encoding="utf-8"):
            if line.startswith("version:"):
                return line.split(":", 1)[1].strip().strip('"')
    return None


def print_registration(harness, root=None):
    """Print the configuration lines to register — **print only, touch no files**.

    Why not write them directly: both of these harnesses keep their settings in a
    file that belongs to the **user** (Codex's `config.toml` holds the model,
    notify and mcp_servers; dsh's patch file may contain `!!js` expressions).
    Having a script edit them is both a risk and exactly the behaviour antivirus
    heuristics look for (an unsigned script editing another application's config —
    Kaspersky deleted one of our installer scripts over precisely that). Printing
    them and letting the agent append means the user can see what is about to be
    added before it happens.

    It is still a pinned command: the path, format and content are all computed, so
    the agent has nothing to improvise — and improvising a path is the easiest
    mistake to make here (on Windows it has to be a file:/// URL).
    """
    here = os.path.dirname(os.path.abspath(__file__))
    if harness == "codex":
        # Codex's marketplace root is **the level that contains .agents/**, i.e. the
        # root of this tree. The Windows ChatGPT app ships no CLI, so registration
        # has to be done by hand in config.toml; `source` uses a TOML literal string
        # (single quotes), inside which backslashes are not escapes.
        config = os.path.join(os.environ.get("USERPROFILE") or os.path.expanduser("~"), ".codex", "config.toml")
        print("# Append to %s (back it up first):" % config)
        print()
        print("[marketplaces.agent-avatar]")
        print('source_type = "local"')
        print("source = '%s'" % here)
        print()
        print('[plugins."agent-avatar@agent-avatar"]')
        print("enabled = true")
        return 0
    if harness == "dsh":
        entry = os.path.join(root or os.path.join(here, "plugins", "dsh", "agent-avatar"), "index.mjs")
        # 🔴 dsh imports this string as an ESM specifier, and Node parses `C:/…` as a
        # URL whose scheme is `c:` (ERR_UNSUPPORTED_ESM_URL_SCHEME). It must be a
        # file:/// URL.
        url = pathlib.Path(os.path.abspath(entry)).as_uri()
        print("# Append to $DSH_HOME/cordis.patch.yml (defaults to %s; back it up first):"
              % os.path.join("~", ".dsh"))
        print("# If the file contains just a line with `[]`, delete that line — an empty")
        print("# array followed by entries is invalid YAML.")
        print()
        print("# >>> agent-avatar (managed) >>>")
        print("- insert:")
        print("    - id: agent-avatar")
        print("      name: %s" % url)
        print("# <<< agent-avatar (managed) <<<")
        return 0
    print("%s needs no extra registration: its own CLI installs the plugin (see the README)" % harness)
    return 0


def main():
    # On Windows stdout defaults to the system code page (cp936 on a Simplified
    # Chinese machine), and the output of this command is meant to be read by an
    # agent — the far end of the pipe would receive mojibake. Pin it to UTF-8.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass                      # old Python, or already redirected: not worth failing over

    parser = argparse.ArgumentParser(description="Localise the plugin tree to this machine (needed on Windows)")
    parser.add_argument("harness", choices=HARNESSES)
    parser.add_argument("--root", help="plugin tree root; defaults to plugins/<harness>/agent-avatar")
    parser.add_argument("--print-registration", action="store_true",
                        help="only print the configuration lines to register, change no files (codex / dsh)")
    arguments = parser.parse_args()

    if arguments.print_registration:
        return print_registration(arguments.harness, arguments.root)

    here = os.path.dirname(os.path.abspath(__file__))
    root = arguments.root or os.path.join(here, "plugins", arguments.harness, "agent-avatar")
    if not os.path.isdir(root):
        raise SystemExit("plugin directory not found: %s" % root)

    python = hook_path(sys.executable)
    layout = LAYOUT[arguments.harness]

    if layout["config"] is None:
        # The Hermes plugin is an in-process Python package: it runs inside Hermes's
        # own interpreter and spawns nothing — the only one of the five that needs no
        # localisation.
        print("hermes needs no localisation (in-process Python package, runs in Hermes's own interpreter)")
        return 0

    config = os.path.join(root, layout["config"])
    if not os.path.isfile(config):
        raise SystemExit("config file not found: %s" % config)

    if arguments.harness == "dsh":
        count = rewrite_index_mjs(config, python)
    else:
        count = rewrite_hooks_json(config, python, arguments.harness)

    state = smoke_test(root, arguments.harness)
    record_install(arguments.harness, root, python, state)
    # Details first, verdict last — and **the verdict is one line**.
    #
    # Why that matters: whoever runs this is usually an agent installing on a user's
    # behalf, and the user is not a developer. An earlier version of the install prompt
    # explained our epistemics here ("the exit code proves nothing, go and check the
    # state file yourself"), which a capable agent answers by *proving* it — three
    # independent lines of evidence, md5 sums, ruled-out false positives. All correct,
    # and all noise to somebody who just wants to know whether it worked.
    #
    # So the tool states the conclusion and the prompt tells the agent to relay this
    # line and nothing else. The detail above stays for the case that actually needs
    # it: when something failed.
    print("interpreter: %s" % python)
    if python != sys.executable.replace("\\", "/"):
        print("  (the original path contains spaces; using the 8.3 short path on the command line)")
    print("rewrote %d command(s) -> %s" % (count, config))
    print("OK: %s connector is installed and self-tested on this machine. "
          "Start a new %s session and the avatar will follow along."
          % (arguments.harness, arguments.harness))
    return 0


if __name__ == "__main__":
    sys.exit(main())
