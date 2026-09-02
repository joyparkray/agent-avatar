# Troubleshooting

## Where the logs are

```
/tmp/agent-avatar-webview.log        one JSON object per line, rotated
```

Override with the `AGENT_AVATAR_LOG` environment variable. Useful lines:

| Event | Meaning |
|---|---|
| `model:loaded` / `model:failed` | Whether the model loaded, and the error if not |
| `model:offscreen-unsupported` | The model needs Cubism 5.1 offscreen compositing (see [MODELS.md](MODELS.md)) |
| `semantic:state-file` | Whether the agent state file was found |
| `endpoint:discovered` | Which audio endpoint was found (URL and whether a token exists — never the token) |
| `visual-state` | Every state change the avatar performed |

## The avatar never changes state

1. **Is the connector installed *and* activated?** Each harness needs a different final
   step — Codex needs `/hooks` approval, WorkBuddy needs an app restart. See
   [CONNECTORS.md](CONNECTORS.md).
2. **Is the right source selected?** Right-click → Agent State Source must match the
   harness you installed (or be *Auto*).
3. **Does the state file exist?** Connectors write to your temp directory:

   ```
   $TMPDIR/agent-avatar-state.json            (Hermes)
   $TMPDIR/agent-avatar-state.<harness>.json  (all others)
   ```

   If it is missing, the connector never ran. If it exists but never changes, the
   harness is not sending the events the connector subscribes to.
4. **`$TMPDIR` must match.** The harness and the avatar have to agree on the temp
   directory. macOS gives each user a per-session `$TMPDIR`; running one of them under a
   different user or a sandbox that redirects `$TMPDIR` breaks the handoff.

## Nothing happens with fast tools

`executing` can last a few milliseconds. Test with something slow — `sleep 4` — before
concluding the pipeline is broken.

## The mouth never moves

Right-click → Audio Source:

- **System audio** works for any agent that speaks out loud, and is the default.
  macOS will ask for audio-capture permission the first time.
- **Hermes** only carries audio when Hermes desktop is running with a speech stream.
- **File** plays a local audio file, for testing.
- **Off** disables lip sync.

## A model fails to load

The app falls back to the last model that worked, once per session. If that also fails,
you get a card with a **Pick another model…** button — the right-click menu at that point
is a reduced version that can still switch models, so you are never stuck with a broken
model that reloads on every launch.

Common causes are covered in [MODELS.md](MODELS.md): archives that were never unzipped,
folders without a `*.model3.json`, and Cubism 5.1 offscreen models.

## The character has missing parts, or coloured rectangles

That model uses Cubism 5.1 offscreen compositing, which the current renderer cannot draw.
The status bar says so on load. See [MODELS.md](MODELS.md#cubism-version-support).

## I can't click the character

Click-through mode is on (right-click → Click Through). Hover over the character for
3 seconds and it becomes interactive again. The status bar tells you when the mode is
active.

Outside the character's bounding box the window is deliberately transparent to clicks,
so you can use whatever is behind it. The box is a rectangle around the model, not its
silhouette, so blank areas close to the character still count as the character.

## The cursor stays an arrow over the character

The character area uses the `grab` cursor. If you see a plain arrow instead, check
whether you are viewing the machine through **remote desktop software** — several clients
draw their own cursor and never sync the remote cursor shape. The same applies to any
other app on that machine; hover a link in a browser to confirm. This is not something
the app can fix from its side.

## Reporting a bug

Include the last few dozen lines of `/tmp/agent-avatar-webview.log`, your macOS version,
which harness and connector, and the model you were using. The log contains no
credentials — tokens are recorded only as "present or absent".
