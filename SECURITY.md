# Security

## Reporting

Please report security issues privately through GitHub's *Report a vulnerability*
button (Security → Advisories) rather than opening a public issue. If that button is not
visible to you, open an issue saying only that you have a security report and asking for
a private channel — do not include details in it.

## What this app touches

Agent Avatar is a desktop application with a few capabilities worth knowing about:

- **It installs plugins into your agent harness, and can run that installer for you.**
  Settings → Agent → Connectors downloads `agent-avatar-connectors.zip` over HTTPS from
  this project's GitHub release, extracts it under the app's data directory, and runs the
  harness's own `install-plugin.sh` from it. You can do the same by hand instead — the
  zip is a published release asset and the scripts are in this repository.

  **Connectors never modify harness source code.** What an installer does beyond copying
  plugin files differs per harness, and it is worth knowing which:

  | Harness | What the installer touches |
  |---|---|
  | Claude Code | Plugin files only, under `~/.claude/plugins/local/agent-avatar` |
  | Hermes | Plugin files only, under `~/.hermes/plugins/agent-avatar`; your `config.yaml` is not touched (you enable the plugin yourself) |
  | DeepSeek Harness | Plugin files, plus one marked block in `~/.dsh/cordis.patch.yml`; the file is backed up first and your own entries are preserved |
  | Codex | Plugin files, plus an `agent-avatar` entry in `~/.agents/plugins/marketplace.json` (backed up first, other entries preserved), then runs `codex plugin add` |
  | WorkBuddy | Plugin files under a local marketplace in `~/.workbuddy`, then runs the bundled `codebuddy` CLI to register and install it |

  Uninstalling from the app reverses these: it removes the plugin directory, strips the
  managed block from the dsh patch file, removes the Codex marketplace entry, and calls
  the WorkBuddy CLI's own uninstall.
- **It captures system audio** (macOS Core Audio process tap) to drive lip sync, only
  while that audio source is selected. Audio is reduced to a loudness value and is never
  recorded or written to disk.
- **It reads a state file** in `$TMPDIR` written by the connector (mode 0600; it holds
  the agent's current state, and `AGENT_AVATAR_STATE_PATH` overrides where the app looks
  for it), and optionally
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
