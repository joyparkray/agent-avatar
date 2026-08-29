# Models

Agent Avatar ships **no Live2D model**. Third-party models come with very different
redistribution terms, so you install your own. This page covers where to get one, how to
install it, and what will not work.

## Where to get a model

Live2D publishes free sample models under its Free Material License:

- <https://www.live2d.com/en/learn/sample/>

Anything exported from Cubism as a **runtime model** works, whether you made it, bought
it, or downloaded it — as long as its own license allows you to use it that way. The
model's license is between you and its author; Agent Avatar does not redistribute models.

## Install

Two ways, both equivalent:

- **Drag the folder into Settings → Models.** The drop zone accepts a folder; it is
  copied into the app's model directory.
- **Put the folder in the models directory yourself**, then pick it in the right-click
  menu. Right-click → Models → *Open Models Folder in Finder* takes you there:

  ```
  ~/Library/Application Support/io.github.joyparkray.agentavatar/models/
  ```

The menu re-scans the directory every time you open it, so a folder you copied in
manually shows up without restarting.

## What a model folder must contain

A `*.model3.json` file, within the folder or up to two levels below it. Everything else
— textures, motions, expressions, physics — is found through that file, exactly as
Cubism exports it. A typical download unzips to:

```
my_model/
└── runtime/
    ├── my_model.model3.json
    ├── my_model.moc3
    ├── my_model.4096/…        textures
    ├── motions/…
    └── expressions/…
```

Both `my_model/` and `my_model/runtime/` are accepted.

### Optional: `avatar.json`

Without it, Agent Avatar reads the model's own `model3.json` and maps every agent state
to the model's idle motion group. That works, but every state looks the same.

You can instead map states yourself in **Settings → Agent**, per model, without writing
any file. `avatar.json` is only needed if you want to ship a model with its mapping
baked in:

```json
{
  "id": "haru", "version": "1.0.0", "cubismVersion": 4,
  "model": "Haru.model3.json",
  "motions": { "idle": ["Idle", 0], "writing": ["TapBody", 2], "error": ["TapBody", 1] },
  "expressions": { "writing": "F03", "error": "F08" },
  "reactions": { "blocked": "F07", "interrupted": "F05" }
}
```

Motion indices and expression names are validated against the model on load — a mapping
that points at something the model does not have is reported instead of silently
never playing.

## Cubism version support

| Model | Supported |
|---|---|
| Cubism 3 / 4 (`moc3` v1–v4) | ✅ |
| Cubism 5.0 (`moc3` v5) | ✅ |
| Cubism 5.1+ **without** offscreen compositing | ✅ |
| Cubism 5.1+ **with** offscreen compositing | ❌ |

Agent Avatar bundles Cubism Core 6.0.1, so recent models load. But the renderer is
`pixi-live2d-display`, which is built on the **Cubism 4 Framework** and has no concept of
offscreens — parts that should be composited through an offscreen buffer get flattened
into a single pass and end up hidden behind other parts, along with stray coloured
rectangles. Live2D's own *Ren* sample is one of these.

Rather than render it wrong in silence, the app detects it: on load the status bar says
*"This model uses Cubism 5.1, which the current renderer does not support"*, and the
model gallery lists the same warning.

Every JavaScript renderer in the ecosystem is on the Cubism 4 Framework today. The
official Cubism Web Framework 5 supports offscreens, but its license requires a separate
Live2D Publication License to distribute derivative works, which does not fit an openly
published project. If that changes, this limitation goes away.

## When a folder is not recognised

Settings → Models lists what it could not use and why:

| Message | Fix |
|---|---|
| *is an archive* | Unzip it first and keep the **extracted folder** — the `.zip` itself is not a model |
| *no `*.model3.json` within two folder levels* | Not a runtime model export, or the model sits deeper — move the inner folder up |
| *name must use only letters, numbers, - or \_* | Rename the folder; the name becomes an identifier |

If a model installs but fails to load, the app falls back to the last model that worked
and offers a way out from the right-click menu — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
