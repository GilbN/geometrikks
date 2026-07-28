"""Access-log top-N CAGGs on real TimescaleDB (issue #58).

Covers CAGG existence/wiring, stitched-exact parity of the routed
SummaryStatsRepository top-N reads against LiveStatsRepository raw scans,
filter routing, and the CAGG-backed access-log facets.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from geometrikks.server.timescale import refresh_caggs_range

# Wall-clock derived, hour-aligned (see test_repositories_pg.py for why).
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

# Misaligned >24h window: neither edge on an hour boundary, so CAGG reads
# must stitch partial head/tail buckets from raw access_logs.
B_START = NOW - timedelta(days=3) + timedelta(minutes=30)
B_END = NOW - timedelta(minutes=30)

NEW_CAGGS = (
    "log_ip_hourly_stats",
    "log_ip_daily_stats",
    "url_hourly_stats",
    "url_daily_stats",
    "user_agent_hourly_stats",
    "user_agent_daily_stats",
)


class TestCaggWiring:
    async def test_new_caggs_exist(self, pg_engine):
        async with pg_engine.connect() as conn:
            names = [
                r[0]
                for r in await conn.execute(text(
                    "SELECT view_name FROM timescaledb_information.continuous_aggregates"
                ))
            ]
        for cagg in NEW_CAGGS:
            assert cagg in names

    async def test_new_caggs_are_refreshable(self, pg_engine, clean_tables):
        """Names must be on the refresh allowlist and the CALL must succeed."""
        await refresh_caggs_range(
            pg_engine,
            start=NOW - timedelta(days=4),
            end=NOW + timedelta(hours=1),
            caggs=list(NEW_CAGGS),
        )
