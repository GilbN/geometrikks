"""The seeder against the real schema, so it breaks in CI instead of rotting when a column changes."""
from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from tests.seed.config import SeedConfig
from tests.seed.seeder import run_seed
from tests.seed_support import FakeGeoSource

pytestmark = pytest.mark.anyio

SERVERS = ("seed-it-a", "seed-it-b")


async def test_seed_writes_linked_rows_and_refreshes(
    pg_engine, migrated_database_url, clean_tables, clean_server_locations
) -> None:
    # Ends a day back so the refresh has whole daily buckets to materialize.
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) - timedelta(days=1)
    config = SeedConfig(rows=3_000, days=3, visitors=150, batch_size=700, servers=SERVERS, end=end)

    stats = await run_seed(config, FakeGeoSource(), migrated_database_url)

    assert stats.failed_caggs == []
    assert stats.access_logs == 3_000
    async with pg_engine.connect() as conn:
        counts = (await conn.execute(text("""
            SELECT
                (SELECT count(*) FROM access_logs),
                (SELECT count(*) FROM geo_events),
                (SELECT count(*) FROM access_log_debug),
                (SELECT count(*) FROM access_log_debug d
                  WHERE d.access_log_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM access_logs a WHERE a.id = d.access_log_id)),
                (SELECT count(*) FROM geo_locations WHERE last_hit IS NULL),
                (SELECT count(*) FROM (
                    SELECT ip_address FROM geo_events GROUP BY 1 HAVING count(DISTINCT location_id) > 1
                ) moved),
                (SELECT sum(total_requests) FROM summary_daily_stats)
        """))).one()
        servers = (await conn.execute(text(
            "SELECT server FROM server_locations WHERE source = 'auto' ORDER BY server"
        ))).scalars().all()

    access_logs, geo_events, debug_rows, dangling, unhit, moved, daily_total = counts
    assert (access_logs, geo_events, debug_rows) == (stats.access_logs, stats.geo_events, stats.debug_rows)
    assert geo_events == access_logs
    assert (dangling, unhit, moved) == (0, 0, 0)
    assert daily_total == access_logs
    assert list(servers) == list(SERVERS)


async def test_seed_reset_empties_earlier_traffic_and_its_buckets(
    pg_engine, migrated_database_url, clean_tables, clean_server_locations
) -> None:
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) - timedelta(days=1)
    first = SeedConfig(rows=800, days=4, visitors=60, servers=SERVERS, end=end)
    await run_seed(first, FakeGeoSource(), migrated_database_url)

    second = dataclasses.replace(first, rows=500, days=1, seed=7)
    stats = await run_seed(second, FakeGeoSource(), migrated_database_url, reset=True)

    assert stats.failed_caggs == []
    async with pg_engine.connect() as conn:
        access_logs, daily_total, hourly_total, server_events = (await conn.execute(text("""
            SELECT
                (SELECT count(*) FROM access_logs),
                (SELECT sum(total_requests) FROM summary_daily_stats),
                (SELECT sum(total_requests) FROM summary_hourly_stats),
                (SELECT sum(event_count) FROM server_daily_stats)
        """))).one()
    assert access_logs == daily_total == hourly_total == server_events == stats.access_logs == 500
