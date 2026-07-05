"""Alembic migration-chain sanity — no database required."""
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

REPO_ROOT = Path(__file__).resolve().parent.parent


def _script_directory() -> ScriptDirectory:
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "migrations"))
    return ScriptDirectory.from_config(cfg)


def test_single_head() -> None:
    """A forked migration history breaks `upgrade head`; exactly one head allowed."""
    heads = _script_directory().get_heads()
    assert len(heads) == 1, f"expected exactly one alembic head, got {heads}"


def test_revisions_parse_and_chain() -> None:
    """Every revision file loads and the chain walks back to base."""
    script = _script_directory()
    revisions = list(script.walk_revisions("base", "heads"))
    assert revisions, "no revisions found — baseline revision missing"
    # walk_revisions yields head → base; the last one is the root.
    assert revisions[-1].down_revision is None
