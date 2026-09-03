"""Registering dsh writes its patch file — so the writing has to be safe.

dsh is the only harness with no plugin CLI at all, so for it `cordis.patch.yml` *is* the
install. Codex briefly looked like a second such case — the `codex` binary is not on
PATH on Windows — but the ChatGPT app does ship it, and `codex plugin add` also creates
the cache copy that Codex actually loads. Writing that file ourselves would be a
half-install, so it goes through the CLI like the rest.

The dsh edit used to be "the script prints a block, the agent pastes it", which was the
most error-prone step of all five harnesses — YAML is
indentation-sensitive, the entry has to be a file:/// URL, and a malformed patch file
fails silently because this path discards the plugin's stderr.

Now the script writes it. These tests pin the ways that could go wrong: writing twice,
failing to recognise an entry pasted by hand under the old prompt, and disturbing
anything else the user keeps in that file.

They call `edit_dsh_registration` directly rather than through the CLI: the CLI runs
localisation and a smoke test first, which needs a real plugin tree. Whether the whole
command works end to end is answered by running it against a real harness, not here.
"""

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
LOCALIZE = HERE / "localize.py"

_spec = importlib.util.spec_from_file_location("localize_under_test", LOCALIZE)
localize = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(localize)

PLUGIN_ROOT = "/somewhere/agent-avatar-connectors/plugins/dsh/agent-avatar"


def register(tmp_path, remove=False):
    os.environ["DSH_HOME"] = str(tmp_path)
    try:
        return localize.edit_dsh_registration(PLUGIN_ROOT, remove=remove)
    finally:
        os.environ.pop("DSH_HOME", None)


def patch_file(tmp_path):
    path = tmp_path / "cordis.patch.yml"
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def test_registering_twice_leaves_one_entry(tmp_path):
    register(tmp_path)
    register(tmp_path)
    assert patch_file(tmp_path).count("id: agent-avatar") == 1
    # A bare C:/ path makes Node read the drive letter as a URL scheme
    assert "file:///" in patch_file(tmp_path)


def test_an_entry_pasted_by_hand_is_still_ours(tmp_path):
    """The old prompt had the agent paste this by hand, so the markers may be missing.

    Not recognising it means `--register` silently produces a second copy on every
    machine that followed the old prompt.
    """
    (tmp_path / "cordis.patch.yml").write_text(
        "- insert:\n    - id: agent-avatar\n      name: file:///somewhere/old/index.mjs\n",
        encoding="utf-8")
    register(tmp_path)
    assert patch_file(tmp_path).count("id: agent-avatar") == 1
    assert "somewhere/old" not in patch_file(tmp_path), "the stale entry has to go, not just be joined"

    register(tmp_path, remove=True)
    assert "agent-avatar" not in patch_file(tmp_path)


def test_the_users_own_entries_survive_both_ways(tmp_path):
    """This file belongs to the user; ours is one entry in it."""
    theirs = "- insert:\n    - id: their-plugin\n      name: file:///theirs/index.mjs\n"
    (tmp_path / "cordis.patch.yml").write_text(theirs, encoding="utf-8")

    register(tmp_path)
    assert "their-plugin" in patch_file(tmp_path)
    register(tmp_path, remove=True)
    assert patch_file(tmp_path).strip() == theirs.strip()


def test_an_empty_list_marker_is_removed(tmp_path):
    """A bare `[]` above real entries is invalid YAML — dsh would stop parsing."""
    (tmp_path / "cordis.patch.yml").write_text("[]\n", encoding="utf-8")
    register(tmp_path)
    assert "[]" not in patch_file(tmp_path)


def test_the_previous_contents_are_kept_somewhere(tmp_path):
    (tmp_path / "cordis.patch.yml").write_text("- insert:\n    - id: their-plugin\n", encoding="utf-8")
    register(tmp_path)
    backup = tmp_path / "cordis.patch.yml.agent-avatar-backup"
    assert backup.is_file() and "their-plugin" in backup.read_text(encoding="utf-8")


def test_register_is_rejected_where_the_harness_does_it_itself():
    """Only dsh's file is ours to write.

    The other four register through their own CLI, and writing their ledgers behind
    their back is how a second source of truth starts drifting — and, in Codex's case,
    would skip the cache copy it actually loads.
    """
    for harness in ("claude-code", "workbuddy", "hermes", "codex"):
        result = subprocess.run([sys.executable, str(LOCALIZE), harness, "--register"],
                                capture_output=True, text=True, check=False)
        assert result.returncode != 0, harness
        assert "own CLI" in (result.stderr + result.stdout), harness
