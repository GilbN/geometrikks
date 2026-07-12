"""Repository + CAGG-routing tests on real TimescaleDB, seeded via polyfactory."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from geometrikks.domain.analytics.repositories import (
    StatsGranularity,
    SummaryStatsRepository,
    get_stats_granularity,
)
from geometrikks.domain.geo.repositories import GeoLocationRepository
from geometrikks.server.timescale import refresh_caggs_range
from tests.seed.factories import AccessLogFactory, GeoLocationFactory, seed_factories

# Derived from the wall clock, not hard-coded: the scratch DB has live
# retention policies (raw data > 180 days is droppable), so a fixed date
# would eventually age out of the window and let a policy job drop seeded
# rows mid-session. Hour-aligned so seeds land deterministically in hourly
# CAGG buckets.
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

LOCATION_COLUMNS = (
    "geohash", "latitude", "longitude", "country_code", "country_name",
    "state", "state_code", "city", "postal_code", "timezone",
)


async def seed(session_maker, *, days_back: int, per_day: int) -> None:
    """Insert locations + paired access logs/geo events spread over days_back days.

    Plain SQL INSERTs with factory-generated values rather than ORM add():
    keeps the fixture independent of the ingestion code under test. geo_events
    and access_logs are id-only bases (no created_at/updated_at columns);
    geo_locations is an audit base and has both.
    """
    seed_factories(42)
    async with session_maker() as session:
        location_ids: list[int] = []
        for loc in GeoLocationFactory.batch_dicts(3):
            result = await session.execute(
                text(
                    "INSERT INTO geo_locations "
                    "(geohash, latitude, longitude, geographic_point, country_code, "
                    " country_name, state, state_code, city, postal_code, timezone, "
                    " last_hit, created_at, updated_at) "
                    "VALUES (:geohash, :latitude, :longitude, "
                    " ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)::geography, "
                    " :country_code, :country_name, :state, :state_code, :city, "
                    " :postal_code, :timezone, now(), now(), now()) "
                    "RETURNING id"
                ),
                {k: loc[k] for k in LOCATION_COLUMNS},
            )
            location_ids.append(result.scalar_one())

        for day in range(days_back):
            ts = NOW - timedelta(days=day, hours=1)
            for i in range(per_day):
                log = AccessLogFactory.build_dict(timestamp=ts, ip_address=f"10.0.{day}.{i}")
                await session.execute(
                    text(
                        "INSERT INTO access_logs (timestamp, ip_address, method, url, "
                        " status_code, bytes_sent, request_time) "
                        "VALUES (:timestamp, :ip_address, 'GET', '/x', :status_code, "
                        " :bytes_sent, :request_time)"
                    ),
                    {
                        "timestamp": ts,
                        "ip_address": log["ip_address"],
                        "status_code": 200,
                        "bytes_sent": 1000,
                        "request_time": 0.01,
                    },
                )
                await session.execute(
                    text(
                        "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id) "
                        "VALUES (:timestamp, :ip_address, 'it-test', :location_id)"
                    ),
                    {
                        "timestamp": ts,
                        "ip_address": log["ip_address"],
                        "location_id": location_ids[i % len(location_ids)],
                    },
                )
        await session.commit()


class TestGranularityRouting:
    """Pure routing thresholds (no DB) — belongs here for spec locality."""

    def test_raw_up_to_24h(self):
        assert get_stats_granularity(NOW - timedelta(hours=24), NOW) is StatsGranularity.RAW

    def test_hourly_between_24h_and_30d(self):
        assert get_stats_granularity(NOW - timedelta(days=2), NOW) is StatsGranularity.HOURLY
        assert get_stats_granularity(NOW - timedelta(days=30), NOW) is StatsGranularity.HOURLY

    def test_daily_beyond_30d(self):
        assert get_stats_granularity(NOW - timedelta(days=31), NOW) is StatsGranularity.DAILY


async def test_raw_summary_counts_are_exact(pg_session_maker, clean_tables):
    await seed(pg_session_maker, days_back=1, per_day=10)
    async with pg_session_maker() as session:
        repo = SummaryStatsRepository(session=session)
        stats = await repo.get_summary(NOW - timedelta(hours=23), NOW)
    assert stats is not None
    assert stats.total_log_records == 10
    assert stats.total_geo_records == 10


async def test_cagg_summary_after_refresh(pg_engine, pg_session_maker, clean_tables):
    """>24h range routes to hourly CAGGs; after an explicit range refresh the
    counts must match what was seeded.

    The refresh window deliberately covers every timestamp this module seeds
    (all tests share NOW): TRUNCATE does not clear CAGG materialized data, so
    the refresh is also what wipes any stale buckets from earlier tests.
    """
    await seed(pg_session_maker, days_back=3, per_day=10)

    await refresh_caggs_range(
        pg_engine,
        start=NOW - timedelta(days=4),
        end=NOW + timedelta(hours=1),
    )

    async with pg_session_maker() as session:
        repo = SummaryStatsRepository(session=session)
        stats = await repo.get_summary(NOW - timedelta(days=3, hours=2), NOW)
    assert stats is not None
    assert stats.total_log_records == 30
    assert stats.total_geo_records == 30


async def test_geojson_event_counts_route_raw(pg_session_maker, clean_tables):
    await seed(pg_session_maker, days_back=1, per_day=9)  # 3 locations x 3 events
    async with pg_session_maker() as session:
        repo = GeoLocationRepository(session=session)
        rows = await repo.get_all_with_event_counts(NOW - timedelta(hours=23), NOW)
    assert len(rows) == 3
    assert sum(r.event_count for r in rows) == 9


async def test_geojson_country_filter(pg_session_maker, clean_tables):
    await seed(pg_session_maker, days_back=1, per_day=9)
    async with pg_session_maker() as session:
        repo = GeoLocationRepository(session=session)
        all_rows = await repo.get_all_with_event_counts(NOW - timedelta(hours=23), NOW)
        one_code = all_rows[0].location.country_code
        one_city = all_rows[0].location.city
        filtered = await repo.get_all_with_event_counts(
            NOW - timedelta(hours=23), NOW, country_codes=[one_code]
        )
        city_filtered = await repo.get_all_with_event_counts(
            NOW - timedelta(hours=23), NOW, cities=[one_city]
        )
    assert filtered and all(r.location.country_code == one_code for r in filtered)
    assert len(filtered) <= len(all_rows)
    assert city_filtered and all(r.location.city == one_city for r in city_filtered)


async def test_geojson_country_filter_cagg_path(pg_engine, pg_session_maker, clean_tables):
    """>24h range routes to the location CAGG; filters must apply there too."""
    await seed(pg_session_maker, days_back=3, per_day=9)
    await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=4), end=NOW + timedelta(hours=1),
    )
    async with pg_session_maker() as session:
        repo = GeoLocationRepository(session=session)
        all_rows = await repo.get_all_with_event_counts(NOW - timedelta(days=3, hours=2), NOW)
        one_code = all_rows[0].location.country_code
        filtered = await repo.get_all_with_event_counts(
            NOW - timedelta(days=3, hours=2), NOW, country_codes=[one_code]
        )
    assert filtered and all(r.location.country_code == one_code for r in filtered)
