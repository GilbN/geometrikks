"""Stitched CAGG reads for windows given with a non-UTC offset.

time_bucket aligns CAGG buckets to UTC, so the stitch helpers must find the
head and tail edges in UTC too. Each window below starts and ends mid-bucket
in UTC. One row sits just after the slice a split in the caller's offset
reads as the head, and two sit at the start of the tail slice it reads.
That split skips the first row and counts the other two twice. Each fixture
also has one row a minute inside each end of the window, so a read that
dropped a raw leg would come up short too. In the hourly fixture the split
counts the row before the end twice as well.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from geometrikks.domain.analytics.repositories import (
    LiveStatsRepository,
    StatsGranularity,
    SummaryStatsRepository,
    _stitch_params,
    get_stats_granularity,
)
from geometrikks.domain.geo.repositories import GeoLocationRepository, stitch_params
from geometrikks.domain.geo.repositories import StatsGranularity as GeoGranularity
from geometrikks.server.timescale import refresh_caggs_range

pytestmark = pytest.mark.anyio

TODAY = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
PLUS_TWO = timezone(timedelta(hours=2))
PLUS_FIVE_THIRTY = timezone(timedelta(hours=5, minutes=30))

# Daily: 05:00 at +02:00 is 03:00 UTC. Rows at 23:00 UTC on the first day
# and on the day before the end fall in the slots a +02:00 split gets wrong.
DAILY_START = (TODAY - timedelta(days=40)).replace(hour=3).astimezone(PLUS_TWO)
DAILY_END = (TODAY - timedelta(days=2)).replace(hour=3).astimezone(PLUS_TWO)
DAILY_ROWS = (
    DAILY_START.astimezone(UTC) + timedelta(minutes=1),
    DAILY_END.astimezone(UTC) - timedelta(minutes=1),
    DAILY_START.astimezone(UTC).replace(hour=23),
    DAILY_START.astimezone(UTC) + timedelta(days=10),
    DAILY_END.astimezone(UTC).replace(hour=23) - timedelta(days=1),
    DAILY_END.astimezone(UTC).replace(hour=23) - timedelta(days=1),
)

# Hourly: :40 UTC is :10 at +05:30. Rows at :45 past the next UTC hour
# after the start and at :35 in the end's UTC hour.
HOURLY_START = (TODAY - timedelta(days=6)).replace(hour=4, minute=40).astimezone(PLUS_FIVE_THIRTY)
HOURLY_END = (TODAY - timedelta(days=2)).replace(hour=4, minute=40).astimezone(PLUS_FIVE_THIRTY)
HOURLY_ROWS = (
    HOURLY_START.astimezone(UTC) + timedelta(minutes=1),
    HOURLY_END.astimezone(UTC) - timedelta(minutes=1),
    HOURLY_START.astimezone(UTC).replace(minute=45) + timedelta(hours=1),
    HOURLY_START.astimezone(UTC) + timedelta(days=2),
    HOURLY_END.astimezone(UTC).replace(minute=35),
    HOURLY_END.astimezone(UTC).replace(minute=35),
)

WINDOWS = pytest.mark.parametrize(
    ("start", "end", "rows", "granularity"),
    [
        pytest.param(DAILY_START, DAILY_END, DAILY_ROWS, StatsGranularity.DAILY, id="daily-plus-02"),
        pytest.param(HOURLY_START, HOURLY_END, HOURLY_ROWS, StatsGranularity.HOURLY, id="hourly-plus-0530"),
    ],
)


async def _seed(pg_engine, session_maker, rows) -> int:
    async with session_maker() as session:
        location_id = (await session.execute(text(
            "INSERT INTO geo_locations (geohash, latitude, longitude, geographic_point, "
            "country_code, country_name, city, last_hit, created_at, updated_at) "
            "VALUES ('u4xsu', 59.9, 10.7, ST_SetSRID(ST_MakePoint(10.7, 59.9), 4326)::geography, "
            "'NO', 'Norway', 'Oslo', now(), now(), now()) RETURNING id"
        ))).scalar_one()
        for timestamp in rows:
            await session.execute(text(
                "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, "
                "bytes_sent, user_agent, country_code, country_name, city) "
                "VALUES (:ts, '203.0.113.7', 'GET', '/', 200, 100, 'ua/1.0', 'NO', 'Norway', 'Oslo')"
            ), {"ts": timestamp})
            await session.execute(text(
                "INSERT INTO geo_events (timestamp, ip_address, server, location_id) "
                "VALUES (:ts, '203.0.113.7', 'web', :location_id)"
            ), {"ts": timestamp, "location_id": location_id})
        await session.commit()
    assert await refresh_caggs_range(pg_engine, start=TODAY - timedelta(days=45), end=TODAY) == []
    return location_id


@WINDOWS
async def test_request_totals_match_raw_count(
    pg_engine, pg_session_maker, clean_tables, start, end, rows, granularity
):
    assert get_stats_granularity(start, end) == granularity
    await _seed(pg_engine, pg_session_maker, rows)
    async with pg_session_maker() as session:
        hits, total_bytes = await SummaryStatsRepository(session=session).get_request_totals(start, end)
    assert (hits, total_bytes) == (len(rows), 100 * len(rows))


@WINDOWS
async def test_top_user_agents_match_raw_scan(
    pg_engine, pg_session_maker, clean_tables, start, end, rows, granularity
):
    await _seed(pg_engine, pg_session_maker, rows)
    async with pg_session_maker() as session:
        stitched = await SummaryStatsRepository(session=session).get_top_user_agents(start, end)
        raw = await LiveStatsRepository(session=session).get_top_user_agents(start, end)
    assert stitched == raw
    assert [row.hits for row in stitched] == [len(rows)]


@WINDOWS
async def test_location_top_ips_match_raw_count(
    pg_engine, pg_session_maker, clean_tables, start, end, rows, granularity
):
    location_id = await _seed(pg_engine, pg_session_maker, rows)
    async with pg_session_maker() as session:
        top = await GeoLocationRepository(session=session).get_location_top_ips(location_id, start, end)
    assert [(ip.ip_address, ip.event_count) for ip in top.top_ips] == [("203.0.113.7", len(rows))]


@WINDOWS
def test_stitch_bounds_do_not_depend_on_the_offset(start, end, rows, granularity):
    in_utc = {"start": start, "end": end}
    in_utc["a_start"], in_utc["a_end"] = (
        (TODAY - timedelta(days=39), TODAY - timedelta(days=2))
        if granularity == StatsGranularity.DAILY
        else (start.astimezone(UTC).replace(minute=0) + timedelta(hours=1),
              end.astimezone(UTC).replace(minute=0))
    )
    assert _stitch_params(start, end, granularity) == in_utc
    assert stitch_params(start, end, GeoGranularity(granularity.value)) == in_utc
