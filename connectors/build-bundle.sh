#!/bin/sh
# Assemble the connector tree that ships **inside the app**.
#
# This replaces build-marketplace.sh, and the difference is who installs. That script
# built a tree for each harness to `git clone` itself, because the app was not going to
# touch anything: the user pasted a prompt and their agent ran the commands. Two rounds
# of testing against the real CLIs killed that idea — 14 defects, every one of them from
# an agent exercising latitude, while the deterministic parts never failed once. See
# private/RELEASE-CONNECTOR-WIZARD-DESIGN.md, "2026-09-03 定案".
#
# So the tree is now a **bundled resource**: the app ships it, localises it to the
# interpreter it also ships, and registers it by calling each harness's own CLI. Nothing
# is downloaded at runtime, and the app and the connector can never be different
# versions — which deletes the whole "is the installed connector out of date" problem.
#
# What comes out:
#
#   <out>/marketplace/.claude-plugin/marketplace.json     Claude Code reads this one
#   <out>/marketplace/.agents/plugins/marketplace.json    Codex reads this one
#   <out>/marketplace/.codebuddy-plugin/marketplace.json  WorkBuddy reads this one
#   <out>/marketplace/plugins/<harness>/agent-avatar/     one tree per harness
#   <out>/README.md, README.zh.md                         the manual route (see below)
#
# 🔴 **The tree must stay machine-independent.** Its hooks.json says `python3`; pointing
# it at a real interpreter is an *install-time* step, done by the app, into a copy. Do
# not call assemble.ps1 from here — it bakes this machine's paths in.
#
# Three harnesses share one directory as their marketplace: their manifest filenames
# differ, and they coexist (measured 2026-09-02). Hermes and dsh do not use a
# marketplace at all, but their plugin trees live here too so there is one source.
#
# The README pair is still generated: with the prompt route gone from the app's UI, that
# README *is* the escape hatch for the cases the app cannot reach — a harness running in
# WSL, a container, or on another machine, and repairing a failed install.
#
# Usage: build-bundle.sh [outdir]     default: ../desktop/src-tauri/resources/connectors
# Interpreter: AGENT_AVATAR_PYTHON may override (see assemble.sh)
set -eu

# Where the manual route tells people to clone from. The connectors repo was merged into
# the app repo when the app started shipping the files itself: a separate repo was a
# second publishable artifact to keep version-synced with the app, which is the very
# problem bundling removes.
REPO=joyparkray/agent-avatar

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=${1:-$here/../desktop/src-tauri/resources/connectors}
mkdir -p "$out"
out=$(CDPATH= cd -- "$out" && pwd)
. "$here/pick-python.sh"
python=$(pick_python) || exit 1
tree=$out/marketplace
# 🔴 **先铺进暂存目录，最后再整体换上。** 中途失败（解释器不对、某一家的冒烟自检没过）
# 时，留在原地的要么是上一棵好树、要么什么都没有 —— 绝不能是一棵**缺几家的半成品**：
# 那种树能骗过 app 的自检（它只看目录在不在），于是坏包被打出去，装的时候才炸。
staging=$out/.marketplace-staging

# The version comes from Claude Code's plugin.json — the five ship together, so reading
# one and comparing the rest turns "are they all the same version" into a check that fails.
version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
          "$here/claude-code/plugin/agent-avatar/.claude-plugin/plugin.json" | head -1)
[ -n "$version" ] || { echo "cannot read the version" >&2; exit 1; }
for manifest in "$here/codex/plugin/agent-avatar/.codex-plugin/plugin.json" \
                "$here/workbuddy/plugin/agent-avatar/.codebuddy-plugin/plugin.json"; do
  other=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -1)
  [ "$other" = "$version" ] || { echo "version mismatch: $manifest is $other, expected $version" >&2; exit 1; }
done
# Hermes's manifest is YAML — written differently, has to agree all the same
hermes_version=$(sed -n 's/^version:[[:space:]]*"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' \
                 "$here/hermes/plugin/agent-avatar/plugin.yaml" | head -1)
[ "$hermes_version" = "$version" ] || { echo "version mismatch: hermes is $hermes_version, expected $version" >&2; exit 1; }
# The constant in the core is written into **every state snapshot**; the app reads it to
# tell a stale connector from a current one. Disagreeing with the manifests means
# reporting a version that was never shipped.
core_version=$(sed -n 's/^CONNECTOR_VERSION = "\([^"]*\)".*/\1/p' "$here/../bridge/state_machine.py" | head -1)
[ "$core_version" = "$version" ] || { echo "version mismatch: state_machine.py is $core_version, expected $version" >&2; exit 1; }

# assemble.sh runs a smoke test per harness as it goes: a missing core module is silent
# in a real registration (the hook is skipped, the avatar just never moves).
rm -rf "$staging"
for harness in hermes claude-code codex dsh workbuddy; do
  "$here/assemble.sh" "$harness" "$staging/plugins/$harness/agent-avatar"
done

description='Aggregates your agent'"'"'s session, tool and subagent events into a semantic state for the Agent Avatar desktop companion to read. A pure observer: it changes nothing about the agent and takes no part in permission decisions.'

# Claude Code: `source` is relative to the marketplace root.
# **No version field** — official guidance is that plugin.json wins when both carry one,
# without a warning, so writing it twice only means one day they disagree in silence.
mkdir -p "$staging/.claude-plugin"
cat > "$staging/.claude-plugin/marketplace.json" <<JSON
{
  "name": "agent-avatar",
  "description": "Agent Avatar connectors — let a desktop mascot follow along with your agent",
  "owner": { "name": "Agent Avatar", "url": "https://github.com/$REPO" },
  "plugins": [
    {
      "name": "agent-avatar",
      "description": "$description",
      "source": "./plugins/claude-code/agent-avatar",
      "category": "productivity",
      "homepage": "https://github.com/$REPO"
    }
  ]
}
JSON

# Codex: manifest lives in `.agents/plugins/`, `source` is an object, and the path must
# start with `./` — **an absolute path there is silently dropped** (the plugin simply
# never appears in the list; measured on macOS).
mkdir -p "$staging/.agents/plugins"
cat > "$staging/.agents/plugins/marketplace.json" <<JSON
{
  "name": "agent-avatar",
  "interface": { "displayName": "Agent Avatar" },
  "plugins": [
    {
      "name": "agent-avatar",
      "source": { "source": "local", "path": "./plugins/codex/agent-avatar" },
      "policy": { "installation": "AVAILABLE" },
      "category": "Productivity"
    }
  ]
}
JSON

# WorkBuddy: same shape as Claude Code, manifest directory is `.codebuddy-plugin/`.
mkdir -p "$staging/.codebuddy-plugin"
cat > "$staging/.codebuddy-plugin/marketplace.json" <<JSON
{
  "name": "agent-avatar",
  "description": "Agent Avatar connectors — let a desktop mascot follow along with your agent",
  "owner": { "name": "Agent Avatar" },
  "metadata": { "version": "$version" },
  "plugins": [
    {
      "name": "agent-avatar",
      "description": "$description",
      "source": "./plugins/workbuddy/agent-avatar",
      "version": "$version",
      "category": "productivity",
      "author": { "name": "Agent Avatar" }
    }
  ]
}
JSON

# A broken manifest makes a harness leave that entry out — no error anywhere. So check
# the three of them here, where a failure is loud.
AGENT_AVATAR_TREE=$staging "$python" - <<'PY'
import json, os
root = os.environ["AGENT_AVATAR_TREE"]
manifests = {
    "claude-code": ".claude-plugin/marketplace.json",
    "codex": ".agents/plugins/marketplace.json",
    "workbuddy": ".codebuddy-plugin/marketplace.json",
}
for harness, relative in manifests.items():
    with open(os.path.join(root, relative), encoding="utf-8") as handle:
        doc = json.load(handle)
    entry = doc["plugins"][0]
    source = entry["source"]
    target = source if isinstance(source, str) else source["path"]
    assert target.startswith("./"), "%s: the path must start with ./ — absolute is dropped silently" % relative
    assert os.path.isdir(os.path.join(root, target)), "%s points at a missing directory: %s" % (relative, target)
    print("  %-12s -> %s" % (harness, target))
for harness in ("claude-code", "codex", "workbuddy", "dsh", "hermes"):
    assert os.path.isdir(os.path.join(root, "plugins", harness, "agent-avatar")), harness
PY

# The README is the first thing a person reads on the manual route, so it lives in its
# own template rather than a heredoc — escaping every backtick would make it the kind of
# file nobody wants to edit, and this one should be edited often (every trap a real
# machine hits belongs in its "installed but nothing moves" section).
# English is primary; Chinese is one click away, same convention as the app.
# 全部通过了才换上 —— 这一步之前的任何失败都不会动到已经在用的那棵树。
rm -rf "$tree"
mv "$staging" "$tree"

for language in "" ".zh"; do
  sed -e "s|{{VERSION}}|$version|g" -e "s|{{REPO}}|$REPO|g" \
      "$here/marketplace-README$language.md" > "$out/README$language.md"
done

echo "connector bundle v$version -> $out"
