# Contributing

## Build from source

Requirements: macOS 14.2+, Node 20+, Rust (stable), Xcode command line tools.

```bash
cd desktop
npm ci
npm run tauri dev      # run with hot reload
npm run tauri build    # produce Agent Avatar.app
```

The app bundle lands in `desktop/src-tauri/target/release/bundle/macos/`.

## Tests

All three suites must pass before a change lands:

```bash
cd desktop
npx tsc --noEmit                                  # types
npx vitest run                                    # front-end unit tests
cargo test --manifest-path src-tauri/Cargo.toml   # Rust

cd ../connectors                                  # connector tests (stdlib only)
for h in claude-code codex dsh hermes workbuddy; do
  python3 -m unittest discover -s "$h" -p "test_*.py"
done
```

Connectors are written against the Python standard library only, so they run under
whatever `python3` the user's harness happens to provide.

## Layout

```
desktop/      Tauri app — Rust in src-tauri/, TypeScript in src/
bridge/       Protocol doc + the shared state machine (single source of truth)
connectors/   One directory per harness + assemble.sh
docs/         User-facing documentation
```

`connectors/assemble.sh all` builds self-contained plugin trees into `release/`, which is
not version controlled.

## Conventions

- **Understand the problem before shortening the diff.** The shortest correct change
  wins, but a small change made without reading the real flow is just a second bug.
- **Fix root causes, not symptoms.** If a shared function is wrong, fix it once and check
  every caller.
- **Non-trivial logic ships with a runnable check** — a unit test, or an assertion that
  fails loudly.
- **Comments explain why, not what**, and record what was actually observed. Much of this
  codebase's behaviour was found by capturing real payloads that contradicted the
  documentation; those notes are the most valuable thing in the file.
- **Never guess in a comment or a test.** If something is unverified, say so. An
  unverified guess written as fact will send the next person down the wrong path.
- Observer hooks **always exit 0** and never return values that a harness might act on.

## Adding a harness

See [docs/CONNECTORS.md](docs/CONNECTORS.md#adding-a-harness) and
[bridge/README.md](bridge/README.md). Capture the harness's real events first —
every integration so far found documented behaviour that turned out to be wrong.
