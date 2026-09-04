# DeepSeek Harness connector

<p align="center">
  <b>English</b> · <a href="README.zh.md">简体中文</a>
</p>

> Verified on real hardware: **2026-08-28, dsh 0.1.1-rc.2 (headless profile)**.
> Same trajectory as the other harnesses: `idle → writing → executing → writing → idle`.

## dsh is **not** a Claude Code derivative (an earlier call that was wrong)

The M3 design note said "dsh ships a CC hook bridge, so Claude Code's registration can be
reused unchanged". **A real run disproved it**: the dsh 0.1.1-rc.2 on this machine has no
hook bridge package whatsoever. Its extension point is **cordis events**, whose names,
payloads and registration have nothing in common with CC — the table in
`bridge/pascal_events.py` is of no use here.

So this directory is a **translation layer plus an in-process plugin** (the path described
in BRIDGE-PROTOCOL §6.3), while the state machine is still the one shared copy.

| File | Role |
|:--|:--|
| `plugin/agent-avatar/index.mjs` | the cordis plugin: dsh events → the internal vocabulary |
| `agent-avatar-hook.py` | internal-vocabulary payload → `bridge/state_machine.py` |
| `../localize.py dsh --register` | pins the interpreter and adds one insert to `$DSH_HOME/cordis.patch.yml` |
| `sample-events.mjs` | the sampler (capture one real run before integrating, see §6) |

## 1. Install

**The app does this for you**: Settings → Agent → Connectors → Install.

By hand — for a dsh the app cannot see, or if you want to read the commands first:

```sh
sh connectors/build-bundle.sh ./connector-tree
cd connector-tree/marketplace
python localize.py dsh --register
```

dsh has no plugin CLI at all: **the registration *is* an entry in its patch file**, so
`--register` writes `$DSH_HOME/cordis.patch.yml` (default `~/.dsh`) directly, backing up
whatever was there first. It is idempotent — including against entries pasted in by hand —
and `--unregister` takes it back out; `--print-registration` shows the block without
writing it. Full details are in [the connectors README](../marketplace-README.md).

That file is watched by dsh's HMR (`watchUserPatches`) — **a running dsh hot-reloads it; no
restart needed**. The patch layer is home-level, so it applies to every profile.

> The patch file allows `!!js` expressions, so the tooling **works line by line and does
> not parse YAML** — an ordinary parser would drop the user's existing expression lines.

Two Windows-specific traps, both handled for you:

1. **`localize.py` is not optional here.** The `spawn("python3")` inside `index.mjs` has
   its stderr `ignore`d, and the `error` event only fires when spawn *fails* — while the
   Microsoft Store stub **does start successfully**, printing "Python was not found" and
   exiting 9009. That makes it the quietest of the five failure modes. Localisation writes
   an absolute interpreter path into `index.mjs` (`AGENT_AVATAR_PYTHON` still takes
   precedence).
2. **The entry `name` must be a `file:///` URL**: dsh passes it straight to `import()` as
   an ESM specifier, and Node reads `C:/...` as a URL with scheme `c:`, raising
   `ERR_UNSUPPORTED_ESM_URL_SCHEME` (measured 2026-09-02). A hand-written path usually gets
   this wrong, and the failure is silent because this path discards stderr.

Uninstall: `python localize.py dsh --unregister`, plus
`rm -rf $DSH_HOME/plugins/agent-avatar`.

## 2. 🔴 Only `@mode emit` events may be subscribed

dsh tags every event with its dispatch mode in the `.d.ts`, and that tag alone decides what
an observer is allowed to touch:

| Mode | Example | Subscribable |
|:--|:--|:--|
| `emit` | `session/event`, `session/created`, `subagent/start` | ✅ pure notification; return values do not affect anything |
| `waterfall` | `tools/pre-execute`, `tools/execute`, `agent/pre-step` | ❌ **on the decision path** — the return value changes harness behaviour |
| `serial` | `agent/turn-stopping` | ❌ same |
| `bail` | `slash/input-*` | ❌ same |

This is what BRIDGE-PROTOCOL §7.2 looks like on dsh concretely. **The cost**: the only
tool-start signal is the waterfall `tools/pre-execute`, which we do not touch — fortunately
`session/event`'s `tool/call` is an emit and carries the same information (`callId` /
`name`).

## 3. Event mapping (confirmed by capture)

Real timing (with `sleep 4`):

```
session/created → turn/start(turn=1) → step/start(1,1) → tool/call(callId,name=bash)
→ tool/result(...) → step/end → step/start(1,2) → step/end → turn/end(reason.kind=completed)
```

| dsh | Internal event | Value |
|:--|:--|:--|
| `session/created` | `on_session_start` | `session.id` |
| `session/disposed` | `on_session_finalize` | |
| `session/event` `turn/start` | `pre_llm_call` | `turn_id = data.turn` |
| `session/event` `turn/end` | `post_llm_call` | |
| `session/event` `tool/call` | `pre_tool_call` | `tool_use_id = data.callId`, `tool_name = data.name` |
| `session/event` `tool/result` | `post_tool_call` | `tool_use_id = data.message.source.callId`; failure from `content[].isError` |

**`tool/result` has no top-level `callId`** — the pairing key hides in
`data.message.source.callId`. Getting it wrong means tools never pair up and the avatar
sticks in `executing`.

`assistant/chunk` fires dozens of times per turn and carries no state information, so it is
ignored outright.

## 4. Subagents: shielded, not counted (two measured reasons)

1. **The `subagent/start` listener receives only one argument.** The `.d.ts` declares the
   LifecycleEmitter as `(name, info, parent)`, but `parent` is a scope carrier and is never
   passed to listeners. Following the docs gives `session_id === undefined`, so the
   bookkeeping lands on the subagent itself (observed: the child session's `subagents`
   contains itself and its phase stays on `writing` forever).
2. **dsh subagents are background jobs**: `subagent/end` had not arrived by the time the
   parent session finished answering (in neither of two runs). Counting `awaiting` by
   pairing start with stop would leave the avatar **stuck in that state indefinitely**.

So `subagent/start` does exactly two things: it records the child session id in an ignore
list (its events never drive the avatar), and it emits one `on_session_finalize` for it to
clear any bookkeeping already created (the subagent's `session/created` can arrive before
this notification). The parent session's writing / executing was accurate all along.

## 5. Still to be re-checked

- **The web and tui profiles have not been measured** (this round used headless). In
  particular, whether `session/created` also fires when *resuming* an old session — if it
  does, that amounts to resetting that session.
- What values `turn/end`'s `reason.kind` takes besides `completed`: a user interrupt is
  most likely in there, and getting hold of it would let us wire up the `interrupted`
  reaction.
- A tool denied by the user goes through `approval/request` (**waterfall, not
  subscribable**), so dsh currently has **no `blocked` reaction**.

## 6. Sampling before you integrate

```sh
dsh --profile headless --patch <patch.yml> "run sleep 4 with bash"
```

Put an insert pointing at `sample-events.mjs` in the patch; output goes to
`$AGENT_AVATAR_SAMPLE` (default `/tmp/agent-avatar-dsh-sample.jsonl`). The sampler
**subscribes to emit events only** and **records every argument** — `session/event(session,
event)` takes two, and looking at only the first drops the actual event entirely (which is
how the first round lost it).

**Use a slow tool such as `sleep 4`**: with a fast one `executing` lasts a few
milliseconds, which reads as "the connector isn't working".
