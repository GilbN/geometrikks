"""The scheduler's full refresh against real continuous aggregates."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from geometrikks.server.scheduler import refresh_all_caggs_job

pytestmark = pytest.mark.anyio

TOTALS = text("""
    SELECT
        (SELECT count(*) FROM access_logs),
        (SELECT sum(total_requests) FROM summary_daily_stats),
        (SELECT sum(total_requests) FROM summary_hourly_stats)
""")


async def _insert(pg_engine, count: int, timestamp: datetime) -> None:
    async with pg_engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, bytes_sent) "
                "SELECT :timestamp, '8.8.8.8', 'GET', '/', 200, 1 FROM generate_series(1, :count)"
            ),
            {"timestamp": timestamp, "count": count},
        )


async def test_rows_after_a_full_refresh_still_count(pg_engine, pg_session_maker, clean_tables) -> None:
    now = datetime.now(timezone.utc)
    await _insert(pg_engine, 10, now - timedelta(days=2))
    await _insert(pg_engine, 10, now - timedelta(minutes=20))

    await refresh_all_caggs_job(pg_session_maker)
    await _insert(pg_engine, 5, datetime.now(timezone.utc))

    async with pg_engine.connect() as conn:
        raw, daily, hourly = (await conn.execute(TOTALS)).one()
    assert raw == daily == hourly == 25
