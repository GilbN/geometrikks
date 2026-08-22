"""Daily chart buckets in the caller's timezone.

A "today" range in a non-UTC browser starts mid-UTC-day; UTC day buckets then
pull in the whole previous UTC day and render an extra bar. With ``tz`` the
daily buckets are local days assembled from hourly source data.

Uses Etc/GMT-2 (fixed UTC+2, POSIX sign is inverted) so expectations don't
shift with DST.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from geometrikks.domain.analytics.repositories import (
    AnalyticsFilters,
    LiveStatsRepository,
    StatsGranularity,
    SummaryStatsRepository,
)
from geometrikks.domain.geo.repositories import StatsGranularity as GeoStatsGranularity
from geometrikks.domain.geo.schemas import GeoEventFilters
from geometrikks.domain.geo.services import GeoEventService
from geometrikks.server.timescale import refresh_caggs_range

import pytest

pytestmark = pytest.mark.anyio

TZ = "Etc/GMT-2"

# Wall-clock derived, hour-aligned (see test_repositories_pg.py for why).
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

# Base UTC day two days ago. Local (UTC+2) midnight of the *next* local day
# falls at BASE+22h; the window mimics "today" selected shortly after noon.
BASE = (NOW - timedelta(days=2)).replace(hour=0)
LOCAL_MIDNIGHT = BASE + timedelta(hours=22)
WINDOW_END = BASE + timedelta(days=1, hours=12)

# Event instants: e1 belongs to the earlier local day; e2/e3 to the local day
# starting at LOCAL_MIDNIGHT. In UTC days, e1+e2 share BASE and e3 is alone.
E1 = BASE + timedelta(hours=21)
E2 = BASE + timedelta(hours=23)
E3 = BASE + timedelta(days=1, hours=10)


async def _insert_log(session, *, ts, rt=0.01, ip="10.0.0.1"):
    # access_logs is an id-only base: no created_at/updated_at columns.
    await session.execute(text(
        "INSERT INTO access_logs (timestamp, ip_address, method, url, "
        "status_code, bytes_sent, request_time) "
        "VALUES (:ts, :ip, 'GET', '/x', 200, 100, :rt)"
    ), {"ts": ts, "ip": ip, "rt": rt})


async def _seed_access_logs(session_maker) -> None:
    async with session_maker() as session:
        await _insert_log(session, ts=E1)
        await _insert_log(session, ts=E2, rt=0.01)
        await _insert_log(session, ts=E3, rt=0.03)
        await session.commit()


async def _seed_geo_events(session_maker) -> None:
    async with session_maker() as session:
        result = await session.execute(
            text(
                "INSERT INTO geo_locations "
                "(geohash, latitude, longitude, geographic_point, country_code, "
                " country_name, city, last_hit, created_at, updated_at) "
                "VALUES ('gltz1', 59.91, 10.75, "
                " ST_SetSRID(ST_MakePoint(10.75, 59.91), 4326)::geography, "
                " 'NO', 'Norway', 'Oslo', now(), now(), now()) RETURNING id"
            )
        )
        loc = result.scalar_one()
        for ts, ip in ((E1, "1.1.1.1"), (E2, "1.1.1.1"), (E3, "2.2.2.2")):
            await session.execute(
                text(
                    "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id) "
                    "VALUES (:ts, :ip, 'web1', :loc)"
                ),
                {"ts": ts, "ip": ip, "loc": loc},
            )
        await session.commit()


async def _refresh(pg_engine) -> None:
    await refresh_caggs_range(
        pg_engine, start=BASE - timedelta(days=1), end=NOW + timedelta(hours=1)
    )


class TestSummaryTimeSeries:
    async def test_daily_buckets_are_local_days(self, pg_engine, pg_session_maker, clean_tables):
        await _seed_access_logs(pg_session_maker)
        await _refresh(pg_engine)
        async with pg_session_maker() as session:
            rows = await SummaryStatsRepository(session=session).get_time_series(
                LOCAL_MIDNIGHT, WINDOW_END, granularity=StatsGranularity.DAILY, tz=TZ
            )
        assert [(r.bucket, r.total_requests) for r in rows] == [(LOCAL_MIDNIGHT, 2)]
        row = rows[0]
        assert row.total_bytes == 200
        # Weighted mean of the two in-window hourly buckets (0.01 and 0.03).
        assert row.avg_request_time == pytest.approx(0.02, rel=0.01)
        assert 0.005 < row.p50_request_time < 0.035

    async def test_daily_buckets_stay_utc_without_tz(self, pg_engine, pg_session_maker, clean_tables):
        """The pre-existing UTC behavior is unchanged when no tz is sent."""
        await _seed_access_logs(pg_session_maker)
        await _refresh(pg_engine)
        async with pg_session_maker() as session:
            rows = await SummaryStatsRepository(session=session).get_time_series(
                LOCAL_MIDNIGHT, WINDOW_END, granularity=StatsGranularity.DAILY
            )
        assert [(r.bucket, r.total_requests) for r in rows] == [
            (BASE, 2),
            (BASE + timedelta(days=1), 1),
        ]


class TestFilteredLiveTimeSeries:
    async def test_daily_buckets_are_local_days(self, pg_session_maker, clean_tables):
        await _seed_access_logs(pg_session_maker)
        async with pg_session_maker() as session:
            rows = await LiveStatsRepository(session=session).get_time_series(
                LOCAL_MIDNIGHT,
                WINDOW_END,
                bucket_interval="1 day",
                filters=AnalyticsFilters(ip_addresses=["10.0.0.1"]),
                tz=TZ,
            )
        assert [(r.bucket, r.total_requests) for r in rows] == [(LOCAL_MIDNIGHT, 2)]


class TestAnalyticsGeoTimeSeries:
    async def test_daily_buckets_are_local_days(self, pg_engine, pg_session_maker, clean_tables):
        await _seed_geo_events(pg_session_maker)
        await _refresh(pg_engine)
        async with pg_session_maker() as session:
            rows = await SummaryStatsRepository(session=session).get_geo_time_series(
                LOCAL_MIDNIGHT, WINDOW_END, granularity=StatsGranularity.DAILY, tz=TZ
            )
        assert [(r["bucket"], r["total_events"], r["unique_ips"]) for r in rows] == [
            (LOCAL_MIDNIGHT, 2, 2)
        ]


class TestGeoTimeSeries:
    async def test_unfiltered_daily_buckets_are_local_days(self, pg_engine, pg_session_maker, clean_tables):
        await _seed_geo_events(pg_session_maker)
        await _refresh(pg_engine)
        async with pg_session_maker() as session:
            points = await GeoEventService(session=session).get_time_series(
                LOCAL_MIDNIGHT, WINDOW_END, GeoStatsGranularity.DAILY, GeoEventFilters(), tz=TZ
            )
        assert [(p.timestamp, p.total_events, p.unique_ips) for p in points] == [
            (LOCAL_MIDNIGHT, 2, 2)
        ]

    async def test_filtered_daily_buckets_are_local_days(self, pg_engine, pg_session_maker, clean_tables):
        """Country-filtered daily buckets ride the hourly stitched CAGGs."""
        await _seed_geo_events(pg_session_maker)
        await _refresh(pg_engine)
        async with pg_session_maker() as session:
            points = await GeoEventService(session=session).get_time_series(
                LOCAL_MIDNIGHT,
                WINDOW_END,
                GeoStatsGranularity.DAILY,
                GeoEventFilters(country_codes=["NO"]),
                tz=TZ,
            )
        assert [(p.timestamp, p.total_events, p.unique_ips) for p in points] == [
            (LOCAL_MIDNIGHT, 2, 2)
        ]
