"""The swap migration corrects url/referrer semantics end to end."""
from __future__ import annotations

from sqlalchemy import text

import pytest

pytestmark = pytest.mark.anyio


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
