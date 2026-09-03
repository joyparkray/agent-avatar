# Security

## Reporting

Please report security issues privately through GitHub's *Report a vulnerability*
button (Security → Advisories) rather than opening a public issue. If that button is not
visible to you, open an issue saying only that you have a security report and asking for
a private channel — do not include details in it.

## What this app touches

Agent Avatar is a desktop application with a few capabilities worth knowing about:

- **It installs plugins into your agent harness.** Settings → Agent → Install ships the
  plugin files and a Python interpreter **inside the application** — nothing is
  downloaded — copies them into the app's own data directory, writes that interpreter's
  path into the plugin's hook command line, feeds one synthetic event through to check
  it works, and then registers the plugin **by calling your harness's own CLI**
  (`claude plugin install`, `codex plugin add`, `codebuddy plugin install`,
  `hermes plugins install`). It does not write your harness's configuration files.

  The one exception is **DeepSeek Harness**, which has no plugin CLI: there the
  registration *is* an entry in `~/.dsh/cordis.patch.yml`, so the app writes that file.
  It backs it up first, wraps its entry in `# >>> agent-avatar (managed) >>>` markers,
  and preserves everything else you keep there.

  **Connectors never modify harness source code**, and they are pure observers: they
  read events and write one state file. They return no instructions, block no tool, and
  take no part in an approval decision.

  Two things the app cannot do for you, by design:

  - **Codex hook trust.** Enabling a plugin does not trust its hooks; you approve them
    yourself with `/hooks`. Trust is keyed to the hook's content hash, so a connector
    upgrade needs re-approving.
  - **Restarting your harness.** Plugins load at session start.

  Uninstalling reverses this through the same CLIs, and removes the managed block from
  the dsh patch file. Everything is also documented for doing by hand — see the
  connectors README — for the cases the app cannot reach (a harness in WSL, a container,
  or on another machine).

  **It can check for a newer version of itself** (Settings → 关于 / About, on by
  default, switchable off). That reads one version number from this project's GitHub
  releases and nothing else: no download, no install. With the switch off it makes no
  request at all.
- **It captures system audio** (macOS Core Audio process tap) to drive lip sync, only
  while that audio source is selected. Audio is reduced to a loudness value and is never
  recorded or written to disk.
- **It reads a state file** in the platform temp directory, written by the connector. It
  holds the agent's current state — one of eight fixed words, a fixed phrase naming the
  harness, a counter and a timestamp — plus, for Hermes only, the session token the hook
  picked up. It does **not** contain your prompts, the agent's output, commands it ran or
  files it touched. `AGENT_AVATAR_STATE_PATH` overrides where the app looks for it.
  The file is created `0600` on Unix, where the `/tmp` fallback is shared between users;
  on Windows the temp directory is per-user and the file inherits an ACL granting only
  you, Administrators and SYSTEM. It also optionally
  connects to a local Hermes endpoint on the loopback interface. URLs handed to the
  system opener are restricted to `http://localhost` and `http://127.0.0.1`.
- **It serves your model files** to its own webview from the app's data directory, with
  path traversal rejected.

## Credentials in logs

The diagnostic log records whether a session token exists, never its value, because the
default log path is world-readable.

## Sandboxing and notarisation

Release builds are signed with an Apple Developer ID certificate (hardened runtime,
timestamped) and notarised by Apple, so Gatekeeper accepts a normal double-click. You can
check any download yourself:

```bash
spctl -a -t open --context context:primary-signature -vv "Agent-Avatar-1.0.0-Intel.dmg"
# expected: source=Notarized Developer ID
#           origin=Developer ID Application: Xiaoxiao Sun (Z5G598ZZ8S)
```

The app is **not** sandboxed: it runs connector install scripts and reads the agent state
file, both of which a sandbox would block. Download only from the official Releases page.
