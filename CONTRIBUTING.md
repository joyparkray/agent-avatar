# Contributing

## Build from source

Requirements: macOS 14.2+ (with Xcode command line tools) or Windows 10+, Node 20+,
Rust (stable), and a real Python 3.

The app **ships the connectors inside itself**, so a release build has two steps before
the Tauri build: fetch the interpreter it will hand to the harnesses, and assemble the
connector tree.

```bash
bash connectors/fetch-python.sh    # embedded interpreter (skipped if already present)
bash connectors/build-bundle.sh    # assemble all five connectors into the app resources

cd desktop
npm ci
npm run tauri dev      # run with hot reload
npm run tauri build    # produce the installer
```

Re-run `build-bundle.sh` after touching anything in `bridge/` or `connectors/` —
otherwise the change is simply not in the package you just built.

**Check that `build-bundle.sh` exited 0.** Do not pipe it into `tail`/`head` and read the
exit code of that instead; a shell pipeline reports the *last* command's status, which is
how a failed bundle got packaged and shipped once already. On success it prints
`connector bundle v<version> -> <path>` as its last line.

The build picks its own interpreter, trying `python3`, then `python`, then `py`, and
running each one to check it really is Python 3 — on Windows the name `python3` usually
resolves to a Microsoft Store placeholder that prints an advert and exits, and on a Mac
without the command line tools `/usr/bin/python3` opens an install dialog. Set
`AGENT_AVATAR_PYTHON` to choose explicitly; when you do, a bad value is an error rather
than a silent fallback.

Output:

| Platform | Where the build lands |
| --- | --- |
| macOS | `desktop/src-tauri/target/release/bundle/macos/` |
| Windows | `desktop/src-tauri/target/release/bundle/nsis/` (`npm run pack:portable` for the no-install zip) |

## Tests

All three suites must pass before a change lands:

```bash
cd desktop
npx tsc --noEmit                                  # types
npx vitest run                                    # front-end unit tests
cargo test --manifest-path src-tauri/Cargo.toml   # Rust

cd ../connectors                                  # connector tests, all five harnesses
python3 -m pytest -q                              # needs pytest; see below
```

On Windows use `python` rather than `python3` here, for the reason given above.

**The connector tests need pytest.** They use `tmp_path` and bare `assert`, which
`unittest discover` cannot collect — it reports `Ran 0 tests ... OK`, a green result for
zero tests. This README used to document exactly that command, so if you followed it, you
were not running the 56 connector tests at all.

```bash
python3 -m venv .venv && .venv/bin/pip install pytest
.venv/bin/python -m pytest -q          # from connectors/
```

The connectors *themselves* are standard library only — pytest is a development
dependency, never something a user's harness has to provide.

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
