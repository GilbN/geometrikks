"""The swap migration corrects url/referrer semantics end to end."""
from __future__ import annotations

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text

import pytest

pytestmark = pytest.mark.anyio

REPO_ROOT = Path(__file__).resolve().parents[2]
SWAP_REVISION = "59dc39684c1f"
CAGG_REFRESH_REVISION = "5f1c8a7d24b3"


async def test_upgrade_ran_through_both_halves_of_the_swap(pg_engine) -> None:
    """The scratch DB is migrated to head, so both revisions applied.

    The swap is split in two: a transactional data revision and the
    autocommit CAGG rebuild that cannot share its transaction. If either
    half broke (for example ``CALL refresh_continuous_aggregate`` inside a
    transaction), the session-scoped migration would have failed outright;
    this pins the topology the split relies on and that head was reached.
    """
    cfg = Config(str(REPO_ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(REPO_ROOT / "migrations"))
    script = ScriptDirectory.from_config(cfg)

    chain = [rev.revision for rev in script.walk_revisions("base", "heads")]
    assert chain.index(CAGG_REFRESH_REVISION) < chain.index(SWAP_REVISION), (
        "the CAGG rebuild must come after the swap (walk_revisions yields head first)"
    )

    # advanced-alchemy names the alembic version table `alembic_versions`.
    async with pg_engine.connect() as conn:
        applied = (await conn.execute(text("SELECT version_num FROM alembic_versions"))).scalar()
    assert applied == script.get_current_head()


async def test_swap_statement_is_its_own_inverse(pg_session_maker, clean_tables) -> None:
    """Pins the load-bearing SQL trick the migration's data_upgrades relies on.

    The migration itself already ran against the scratch DB during suite
    setup (a broken migration fails the whole session); this test verifies
    that ``UPDATE access_logs SET url = referrer, referrer = url`` swaps in
    place, since PostgreSQL evaluates all right-hand sides against the
    pre-update row before writing any column.
    """
    async with pg_session_maker() as session:
        await session.execute(text(
            "INSERT INTO access_logs (timestamp, ip_address, status_code, bytes_sent, request_time, url, referrer) "
            "VALUES (now(), '203.0.113.7', 200, 10, 0.1, 'https://ref.example/', '/admin')"
        ))
        await session.execute(text("UPDATE access_logs SET url = referrer, referrer = url"))
        row = (await session.execute(text(
            "SELECT url, referrer FROM access_logs WHERE ip_address = '203.0.113.7' "
            "ORDER BY timestamp DESC LIMIT 1"
        ))).one()
        assert row.url == "/admin"
        assert row.referrer == "https://ref.example/"
        await session.rollback()
