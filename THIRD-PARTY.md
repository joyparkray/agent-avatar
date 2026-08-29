# Third-Party Notices

Agent Avatar itself is MIT licensed (see [LICENSE](LICENSE)). It redistributes and
depends on the components below, which keep their own licenses.

## Redistributed in the application bundle

### Live2D Cubism Core

`desktop/vendor/live2d-core/live2dcubismcore.min.js` — **version 6.0.1**, taken from
Cubism SDK for Web 5-r.5.

Licensed under the **Live2D Proprietary Software License Agreement**, not MIT.
It is redistributed here because Live2D explicitly lists it as redistributable code
(see `RedistributableFiles.txt` shipped alongside it); only files on that list are
included, together with the accompanying `LICENSE-CubismCore.md`.

- License: <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- If your organisation's most recent fiscal year gross revenue is 10,000,000 JPY or
  more, Live2D additionally requires a Cubism SDK Release License:
  <https://www.live2d.com/en/download/cubism-sdk/release-license/>

Removing or modifying the Live2D copyright and license notices inside that file is
not permitted.

## Bundled at build time (npm)

| Component | License |
|---|---|
| [pixi.js](https://github.com/pixijs/pixijs) 8.x | MIT |
| [@jannchie/pixi-live2d-display](https://github.com/jannchie/pixi-live2d-display) 1.4.x | MIT |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) 2.x | MIT OR Apache-2.0 |
| [Tauri](https://github.com/tauri-apps/tauri) 2.x (Rust crates: `tauri`, `tauri-plugin-single-instance`) | MIT OR Apache-2.0 |
| [serde_json](https://github.com/serde-rs/json) | MIT OR Apache-2.0 |
| TypeScript, Vite, Vitest (build/test only, not shipped) | Apache-2.0 / MIT |

The full dependency tree and its licenses can be reproduced with `npm ls` and
`cargo tree` in `desktop/`.

## Not redistributed: Live2D models

**Agent Avatar ships with no Live2D model.** Third-party models come with widely
differing redistribution terms, so you supply your own — see [docs/MODELS.md](docs/MODELS.md).

Live2D's official sample models (Haru, Hiyori, Ren, Mao, and others) are covered by
the **Free Material License**, which governs what you may do with them:
<https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html>

When you install a model, its license stays between you and the model's author.

## The Bridge protocol and connectors

`bridge/` and `connectors/` are part of this project and are MIT licensed. The
harness-side plugin formats they target (Claude Code, Codex, Hermes, DeepSeek
Harness, WorkBuddy) belong to their respective vendors; the connectors only read
each harness's documented hook payloads and never modify harness code.
