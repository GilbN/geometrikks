"""access_logs.request_time accepts NULL after the nullable-timings revision."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import text

import pytest

pytestmark = pytest.mark.anyio


async def test_request_time_column_is_nullable_without_default(pg_engine) -> None:
    async with pg_engine.connect() as conn:
        row = (await conn.execute(text("""
            SELECT is_nullable, column_default FROM information_schema.columns
            WHERE table_name = 'access_logs' AND column_name = 'request_time'
        """))).one()
    assert row.is_nullable == "YES"
    assert row.column_default is None


async def test_insert_without_request_time_stores_null(pg_session_maker, clean_tables) -> None:
    ts = datetime.now(timezone.utc)
    async with pg_session_maker() as session:
        await session.execute(text(
            "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, bytes_sent) "
            "VALUES (:ts, '10.0.0.1', 'GET', '/x', 200, 100)"
        ), {"ts": ts})
        await session.commit()
        stored = (await session.execute(text(
            "SELECT request_time FROM access_logs WHERE ip_address = '10.0.0.1'"
        ))).scalar_one()
    assert stored is None
