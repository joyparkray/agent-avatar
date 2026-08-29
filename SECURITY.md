# Security

## Reporting

Please report security issues privately through GitHub's *Report a vulnerability*
(Security → Advisories) rather than opening a public issue.

## What this app touches

Agent Avatar is a desktop application with a few capabilities worth knowing about:

- **It installs plugins into your agent harness.** Connectors are copied into the
  harness's own plugin directory by a script you run yourself. They never modify harness
  code and never change your harness config file.
- **It captures system audio** (macOS Core Audio process tap) to drive lip sync, only
  while that audio source is selected. Audio is reduced to a loudness value and is never
  recorded or written to disk.
- **It reads a state file** in `$TMPDIR` written by the connector, and optionally
  connects to a local Hermes endpoint on the loopback interface. URLs handed to the
  system opener are restricted to `http://localhost` and `http://127.0.0.1`.
- **It serves your model files** to its own webview from the app's data directory, with
  path traversal rejected.

## Credentials in logs

The diagnostic log records whether a session token exists, never its value, because the
default log path is world-readable.

## Sandboxing and notarisation

Builds are currently unsigned and un-notarised, so macOS Gatekeeper will warn on first
launch. Verify you downloaded the app from the official Releases page.
