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

  **It can check for a newer version of itself** (Settings → About, on by
  default, switchable off). That reads one version number from this project's GitHub
  releases and nothing else: no download, no install. With the switch off it makes no
  request at all.
- **It captures system audio** to drive lip sync, only while that audio source is
  selected — a Core Audio process tap on macOS, WASAPI loopback on Windows. On either
  platform the audio is reduced to a loudness value and is never recorded or written to
  disk.
- **It reads a state file** in the platform temp directory, written by the connector. It
  holds the agent's current state — one of eight fixed words, a fixed phrase naming the
  harness, a counter and a timestamp — plus, for Hermes only, the session token the hook
  picked up. It does **not** contain your prompts or the agent's output.

  **One line is added only if you switch it on** (Settings → General → Status bar →
  *Show what it is doing*, off by default). With it on, the connector also writes a short line naming the
  current step: the tool's own one-line description, or a file **name** (never the path),
  or a **host** (never the rest of the URL), or a search term — capped at 40 characters.
  It never writes a command line, file contents or a replacement string: a command line
  can carry an auth header, and that is the one thing nobody expects to see on screen.
  With the switch off the connector does not read those fields at all, so nothing about
  the tool reaches disk — the switch is a file the app writes for the connector to read,
  not a display filter. `AGENT_AVATAR_STATE_PATH` overrides where the app looks for it.
  The file is created `0600` on Unix, where the `/tmp` fallback is shared between users;
  on Windows the temp directory is per-user and the file inherits an ACL granting only
  you, Administrators and SYSTEM. It also optionally
  connects to a local Hermes endpoint on the loopback interface. URLs handed to the
  system opener are restricted to `http://localhost`, `http://127.0.0.1`, and a short
  named list of the links the app itself prints on its About page (this project's
  repository, the author's profile, the Live2D pages). Anything else is refused —
  the list is a hardcoded allowlist, not a filter, because the webview it is called from
  renders content we do not control (model names, a harness's own error text).
- **It serves your model files** to its own webview from the app's data directory, with
  path traversal rejected.

## Credentials in logs

The diagnostic log records whether a session token exists, never its value, because the
default log path is world-readable.

## Sandboxing and notarisation

**macOS release builds** are signed with an Apple Developer ID certificate (hardened
runtime, timestamped) and notarised by Apple, so Gatekeeper accepts a normal double-click.
You can check any download yourself:

```bash
spctl -a -t open --context context:primary-signature -vv "Agent.Avatar_1.1.0_aarch64.dmg"
# expected: source=Notarized Developer ID
#           origin=Developer ID Application: Xiaoxiao Sun (Z5G598ZZ8S)
```

**Windows builds are not code-signed.** I do not hold a Windows code-signing certificate:
they are issued per year against a paid identity check, and for a free project built in
spare time that cost is hard to justify. The practical consequence is that SmartScreen
shows an "unrecognised app" warning on first run (More info → Run anyway), and that the
installer carries no publisher identity you can verify from the file itself. What you can
verify instead: release assets are built by the [CI workflow](.github/workflows/ci.yml)
from the tagged commit, and GitHub attaches a SHA-256 digest to every asset on the
Releases page — compare it with `Get-FileHash` before running the installer. If you would
rather not trust an unsigned binary at all, [build from source](CONTRIBUTING.md); that is
a supported path on Windows, and CI builds the NSIS installer there on every push and
pull request.

The app is **not** sandboxed: it runs connector install scripts and reads the agent state
file, both of which a sandbox would block. Download only from the official Releases page.
