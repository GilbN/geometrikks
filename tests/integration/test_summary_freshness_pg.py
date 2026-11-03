"""Freshness uses retained event timestamps within the requested window."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from geometrikks.domain.analytics.repositories import SummaryStatsRepository

pytestmark = pytest.mark.anyio


async def test_latest_event_respects_both_range_edges(pg_session_maker, clean_tables):
    end = datetime.now(UTC)
    start = end - timedelta(hours=1)
    latest = end - timedelta(seconds=1)
    async with pg_session_maker() as session:
        for timestamp in (start - timedelta(seconds=1), start, latest, end, end + timedelta(seconds=1)):
            await session.execute(
                text("INSERT INTO access_logs (timestamp, ip_address, status_code, bytes_sent) VALUES (:at, '192.0.2.1', 200, 0)"),
                {"at": timestamp},
            )
        repo = SummaryStatsRepository(session)
        assert await repo.latest_event_at(start, end) == latest
        assert await repo.latest_event_at(start - timedelta(hours=2), start - timedelta(hours=1)) is None
