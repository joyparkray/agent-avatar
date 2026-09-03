"""Registering dsh and Codex writes their config file — so the writing has to be safe.

These two are the ones with no plugin CLI to do it for them: dsh has none at all, and
the Windows ChatGPT app ships no `codex`. For them the config file *is* the install —
`cordis.patch.yml` and `config.toml` respectively. That edit used to be "the script prints a block, the agent pastes
it", which was the most error-prone step of all five harnesses — YAML is
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
CODEX_PLUGIN_ROOT = "/somewhere/agent-avatar-connectors/plugins/codex/agent-avatar"


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
    """Only these two config files are ours to write.

    The other three register through their own `plugin install`, and writing their
    ledgers behind their back is how a second source of truth starts drifting.
    """
    for harness in ("claude-code", "workbuddy", "hermes"):
        result = subprocess.run([sys.executable, str(LOCALIZE), harness, "--register"],
                                capture_output=True, text=True, check=False)
        assert result.returncode != 0, harness
        assert "own CLI" in (result.stderr + result.stdout), harness


# ── Codex ────────────────────────────────────────────────────────────────────────

def codex(tmp_path, remove=False):
    os.environ["CODEX_HOME"] = str(tmp_path)
    try:
        return localize.edit_codex_registration(CODEX_PLUGIN_ROOT, remove=remove)
    finally:
        os.environ.pop("CODEX_HOME", None)


def config_toml(tmp_path):
    path = tmp_path / "config.toml"
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def test_codex_points_at_the_level_that_holds_the_manifest(tmp_path):
    """Codex's marketplace root is the directory containing `.agents/`, three levels up
    from the plugin directory — not the plugin directory, and not `plugins/`.

    Getting it wrong is silent: Codex simply does not list the plugin.
    """
    codex(tmp_path)
    assert "source = '" in config_toml(tmp_path)
    source = config_toml(tmp_path).split("source = '")[1].split("'")[0]
    assert source.replace("\\", "/").endswith("agent-avatar-connectors"), source


def test_registering_codex_twice_leaves_one_pair_of_tables(tmp_path):
    codex(tmp_path)
    codex(tmp_path)
    assert config_toml(tmp_path).count("[marketplaces.agent-avatar]") == 1
    assert config_toml(tmp_path).count('[plugins."agent-avatar@agent-avatar"]') == 1


def test_the_users_codex_settings_survive_both_ways(tmp_path):
    """config.toml holds the model, notify and mcp_servers — ours is two tables in it."""
    theirs = '\n'.join(['model = "gpt-5"', '', "[projects.'c:/code']",
                        'trust_level = "trusted"', ''])
    (tmp_path / "config.toml").write_text(theirs, encoding="utf-8")
    codex(tmp_path)
    assert 'model = "gpt-5"' in config_toml(tmp_path)
    assert "trust_level" in config_toml(tmp_path)
    codex(tmp_path, remove=True)
    assert config_toml(tmp_path).strip() == theirs.strip()


def test_a_table_from_the_older_layout_is_still_ours(tmp_path):
    """An earlier layout named these `agent-avatar-local`, and anyone who registered by
    hand may have either name. Leaving one behind points Codex at a tree that is gone."""
    (tmp_path / "config.toml").write_text('\n'.join([
        "[marketplaces.agent-avatar-local]", 'source_type = "local"', "source = '/old/path'",
        '', '[plugins."agent-avatar@agent-avatar-local"]', "enabled = true", '']),
        encoding="utf-8")
    codex(tmp_path)
    assert "/old/path" not in config_toml(tmp_path)
    assert config_toml(tmp_path).count("[marketplaces.agent-avatar") == 1

    codex(tmp_path, remove=True)
    assert "agent-avatar" not in config_toml(tmp_path)


def test_the_previous_codex_config_is_kept_somewhere(tmp_path):
    (tmp_path / "config.toml").write_text('model = "gpt-5"', encoding="utf-8")
    codex(tmp_path)
    backup = tmp_path / "config.toml.agent-avatar-backup"
    assert backup.is_file() and "gpt-5" in backup.read_text(encoding="utf-8")
