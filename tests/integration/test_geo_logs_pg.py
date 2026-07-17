"""GeoEventService aggregate queries on real TimescaleDB (geo-logs page, issue #18).

Covers grouped (location, IP) rows, summary, time-series, top-N lists and
facets, on both the raw path (≤ 24h or filtered-by-hostname) and the
ip_location_daily_stats / geo_summary CAGG paths.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from geometrikks.domain.geo.repositories import StatsGranularity
from geometrikks.domain.geo.schemas import GeoEventFilters
from geometrikks.domain.geo.services import GeoEventService
from geometrikks.server.timescale import refresh_caggs_range

# Wall-clock derived, hour-aligned (see test_repositories_pg.py for why).
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

# ≤ 24h window → RAW routing for the unfiltered path.
RAW_START = NOW - timedelta(hours=23)


async def _insert_location(
    session, *, geohash: str, latitude: float, longitude: float,
    country_code: str, country_name: str, city: str | None,
    state: str | None = None, state_code: str | None = None,
    postal_code: str | None = None, tz: str | None = None,
) -> int:
    result = await session.execute(
        text(
            "INSERT INTO geo_locations "
            "(geohash, latitude, longitude, geographic_point, country_code, "
            " country_name, state, state_code, city, postal_code, timezone, "
            " last_hit, created_at, updated_at) "
            "VALUES (:geohash, :latitude, :longitude, "
            " ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)::geography, "
            " :country_code, :country_name, :state, :state_code, :city, "
            " :postal_code, :tz, now(), now(), now()) "
            "RETURNING id"
        ),
        {
            "geohash": geohash, "latitude": latitude, "longitude": longitude,
            "country_code": country_code, "country_name": country_name,
            "state": state, "state_code": state_code, "city": city,
            "postal_code": postal_code, "tz": tz,
        },
    )
    return result.scalar_one()


async def _insert_events(session, *, ts, ip: str, hostname: str, location_id: int, n: int = 1) -> None:
    for _ in range(n):
        await session.execute(
            text(
                "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id) "
                "VALUES (:ts, :ip, :hostname, :location_id)"
            ),
            {"ts": ts, "ip": ip, "hostname": hostname, "location_id": location_id},
        )


async def _seed_locations(session) -> dict[str, int]:
    """Three locations; the US one has no city (NULL-city handling)."""
    loc_no = await _insert_location(
        session, geohash="glno1", latitude=59.91, longitude=10.75,
        country_code="NO", country_name="Norway", city="Oslo",
        state="Oslo", state_code="03", postal_code="0150", tz="Europe/Oslo",
    )
    loc_se = await _insert_location(
        session, geohash="glse1", latitude=63.83, longitude=20.26,
        country_code="SE", country_name="Sweden", city="Umea",
    )
    loc_us = await _insert_location(
        session, geohash="glus1", latitude=40.71, longitude=-74.01,
        country_code="US", country_name="United States", city=None,
    )
    return {"no": loc_no, "se": loc_se, "us": loc_us}


async def seed_raw(session_maker) -> dict[str, int]:
    """7 events in the last 24h: 4 distinct (location, IP) groups.

    Expected grouped rows (count desc, then location id / IP tiebreak):
      (no, 1.1.1.1) x3 web1 | (se, 1.1.1.1) x2 web1 | (no, 2.2.2.2) x1 web2 | (us, 3.3.3.3) x1 web2
    """
    t1 = NOW - timedelta(hours=3)
    t2 = NOW - timedelta(hours=2)
    async with session_maker() as session:
        locs = await _seed_locations(session)
        await _insert_events(session, ts=t1, ip="1.1.1.1", hostname="web1", location_id=locs["no"], n=3)
        await _insert_events(session, ts=t2, ip="1.1.1.1", hostname="web1", location_id=locs["se"], n=2)
        await _insert_events(session, ts=t2, ip="2.2.2.2", hostname="web2", location_id=locs["no"], n=1)
        await _insert_events(session, ts=t1, ip="3.3.3.3", hostname="web2", location_id=locs["us"], n=1)
        await session.commit()
    return locs


async def seed_multiday(session_maker) -> dict[str, int]:
    """Same shape spread over 3 days (forces HOURLY/DAILY routing on >24h ranges)."""
    async with session_maker() as session:
        locs = await _seed_locations(session)
        for day in range(3):
            ts = NOW - timedelta(days=day, hours=1)
            await _insert_events(session, ts=ts, ip="1.1.1.1", hostname="web1", location_id=locs["no"], n=2)
            await _insert_events(session, ts=ts, ip="2.2.2.2", hostname="web2", location_id=locs["se"], n=1)
        await session.commit()
    return locs


class TestGroupedLogs:
    async def test_counts_sort_and_tiebreak(self, pg_session_maker, clean_tables):
        locs = await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            rows, total = await GeoEventService(session=session).get_grouped_logs(
                RAW_START, NOW, GeoEventFilters(), limit=50, offset=0
            )
        assert total == 4
        assert [(r.location_id, r.ip_address, r.event_count) for r in rows] == [
            (locs["no"], "1.1.1.1", 3),
            (locs["se"], "1.1.1.1", 2),
            (locs["no"], "2.2.2.2", 1),
            (locs["us"], "3.3.3.3", 1),
        ]
        top = rows[0]
        assert (top.city, top.country_code, top.country_name) == ("Oslo", "NO", "Norway")
        assert (top.state, top.state_code, top.postal_code) == ("Oslo", "03", "0150")
        assert top.latitude == 59.91 and top.longitude == 10.75
        assert top.hostnames == ["web1"]
        assert top.last_seen is not None and top.last_seen.tzinfo is not None

    async def test_pagination_is_stable(self, pg_session_maker, clean_tables):
        locs = await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            svc = GeoEventService(session=session)
            page1, total1 = await svc.get_grouped_logs(RAW_START, NOW, GeoEventFilters(), limit=2, offset=0)
            page2, total2 = await svc.get_grouped_logs(RAW_START, NOW, GeoEventFilters(), limit=2, offset=2)
        assert total1 == total2 == 4
        keys = [(r.location_id, r.ip_address) for r in page1 + page2]
        assert len(set(keys)) == 4  # no overlap between pages
        assert keys[:2] == [(locs["no"], "1.1.1.1"), (locs["se"], "1.1.1.1")]

    async def test_sort_order_asc(self, pg_session_maker, clean_tables):
        await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            rows, _ = await GeoEventService(session=session).get_grouped_logs(
                RAW_START, NOW, GeoEventFilters(), limit=50, offset=0, sort_order="asc"
            )
        assert [r.event_count for r in rows] == [1, 1, 2, 3]

    async def test_each_filter(self, pg_session_maker, clean_tables):
        locs = await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            svc = GeoEventService(session=session)

            by_country, total_country = await svc.get_grouped_logs(
                RAW_START, NOW, GeoEventFilters(country_codes=["no"]), limit=50, offset=0
            )
            by_city, _ = await svc.get_grouped_logs(
                RAW_START, NOW, GeoEventFilters(cities=["Oslo"]), limit=50, offset=0
            )
            by_ip, _ = await svc.get_grouped_logs(
                RAW_START, NOW, GeoEventFilters(ip_include=["1.1.1.1"]), limit=50, offset=0
            )
            by_ip_excl, _ = await svc.get_grouped_logs(
                RAW_START, NOW, GeoEventFilters(ip_exclude=["1.1.1.1"]), limit=50, offset=0
            )
            by_host, _ = await svc.get_grouped_logs(
                RAW_START, NOW, GeoEventFilters(hostnames=["web2"]), limit=50, offset=0
            )

        # lower-cased country input still matches (codes are stored upper-case)
        assert total_country == 2
        assert all(r.country_code == "NO" for r in by_country)
        assert [(r.location_id, r.ip_address) for r in by_city] == [
            (locs["no"], "1.1.1.1"), (locs["no"], "2.2.2.2")
        ]
        assert [(r.location_id, r.ip_address) for r in by_ip] == [
            (locs["no"], "1.1.1.1"), (locs["se"], "1.1.1.1")
        ]
        assert {r.ip_address for r in by_ip_excl} == {"2.2.2.2", "3.3.3.3"}
        assert {r.ip_address for r in by_host} == {"2.2.2.2", "3.3.3.3"}

    async def test_cagg_path_parity(self, pg_engine, pg_session_maker, clean_tables):
        """>24h unfiltered range routes to ip_location_daily_stats: same groups
        and counts as raw seeding, hostnames unavailable ([])."""
        locs = await seed_multiday(pg_session_maker)
        await refresh_caggs_range(
            pg_engine, start=NOW - timedelta(days=4), end=NOW + timedelta(hours=1)
        )
        start = NOW - timedelta(days=3, hours=2)
        async with pg_session_maker() as session:
            rows, total = await GeoEventService(session=session).get_grouped_logs(
                start, NOW, GeoEventFilters(), limit=50, offset=0
            )
        assert total == 2
        assert [(r.location_id, r.ip_address, r.event_count) for r in rows] == [
            (locs["no"], "1.1.1.1", 6),
            (locs["se"], "2.2.2.2", 3),
        ]
        assert all(r.hostnames == [] for r in rows)

    async def test_hostname_filter_forces_raw_on_long_range(self, pg_engine, pg_session_maker, clean_tables):
        locs = await seed_multiday(pg_session_maker)
        await refresh_caggs_range(
            pg_engine, start=NOW - timedelta(days=4), end=NOW + timedelta(hours=1)
        )
        start = NOW - timedelta(days=3, hours=2)
        async with pg_session_maker() as session:
            rows, total = await GeoEventService(session=session).get_grouped_logs(
                start, NOW, GeoEventFilters(hostnames=["web1"]), limit=50, offset=0
            )
        assert total == 1
        assert (rows[0].location_id, rows[0].ip_address, rows[0].event_count) == (
            locs["no"], "1.1.1.1", 6
        )
        assert rows[0].hostnames == ["web1"]  # raw path keeps hostnames


class TestSummary:
    async def test_unfiltered_raw_exact(self, pg_session_maker, clean_tables):
        await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            period = await GeoEventService(session=session).get_summary(
                RAW_START, NOW, GeoEventFilters()
            )
        assert period.total_events == 7
        assert period.unique_ips == 3
        assert period.unique_countries == 3
        assert period.unique_cities == 2  # NULL city (US) not counted

    async def test_filtered_raw_exact(self, pg_session_maker, clean_tables):
        await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            period = await GeoEventService(session=session).get_summary(
                RAW_START, NOW, GeoEventFilters(country_codes=["NO"])
            )
        assert period.total_events == 4
        assert period.unique_ips == 2
        assert period.unique_countries == 1
        assert period.unique_cities == 1

    async def test_unfiltered_cagg_path(self, pg_engine, pg_session_maker, clean_tables):
        """>24h unfiltered range uses geo_summary CAGGs (HLL is exact at this
        cardinality)."""
        await seed_multiday(pg_session_maker)
        await refresh_caggs_range(
            pg_engine, start=NOW - timedelta(days=4), end=NOW + timedelta(hours=1)
        )
        async with pg_session_maker() as session:
            period = await GeoEventService(session=session).get_summary(
                NOW - timedelta(days=3, hours=2), NOW, GeoEventFilters()
            )
        assert period.total_events == 9
        assert period.unique_ips == 2

    async def test_filtered_long_range_uses_raw(self, pg_engine, pg_session_maker, clean_tables):
        """Any filter forces the raw path on long ranges (CAGGs have no dims)."""
        await seed_multiday(pg_session_maker)
        async with pg_session_maker() as session:
            period = await GeoEventService(session=session).get_summary(
                NOW - timedelta(days=3, hours=2), NOW, GeoEventFilters(ip_exclude=["1.1.1.1"])
            )
        assert period.total_events == 3
        assert period.unique_ips == 1


class TestTimeSeries:
    async def test_filtered_raw_buckets(self, pg_session_maker, clean_tables):
        await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            points = await GeoEventService(session=session).get_time_series(
                RAW_START, NOW, StatsGranularity.HOURLY,
                GeoEventFilters(country_codes=["NO"]),
            )
        assert [(p.total_events, p.unique_ips) for p in points] == [(3, 1), (1, 1)]
        assert points[0].timestamp < points[1].timestamp

    async def test_unfiltered_cagg_buckets(self, pg_engine, pg_session_maker, clean_tables):
        await seed_multiday(pg_session_maker)
        await refresh_caggs_range(
            pg_engine, start=NOW - timedelta(days=4), end=NOW + timedelta(hours=1)
        )
        async with pg_session_maker() as session:
            points = await GeoEventService(session=session).get_time_series(
                NOW - timedelta(days=3, hours=2), NOW, StatsGranularity.HOURLY,
                GeoEventFilters(),
            )
        assert sum(p.total_events for p in points) == 9
        assert all(p.unique_ips == 2 for p in points)


class TestTopN:
    async def test_top_ips_grouped_across_locations(self, pg_session_maker, clean_tables):
        await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            rows = await GeoEventService(session=session).get_top_ips(
                RAW_START, NOW, GeoEventFilters(), limit=10
            )
        assert [(r.ip_address, r.event_count) for r in rows] == [
            ("1.1.1.1", 5), ("2.2.2.2", 1), ("3.3.3.3", 1)
        ]
        assert rows[0].country_code in ("NO", "SE")

    async def test_top_ips_respects_limit_and_exclude(self, pg_session_maker, clean_tables):
        await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            svc = GeoEventService(session=session)
            limited = await svc.get_top_ips(RAW_START, NOW, GeoEventFilters(), limit=1)
            excluded = await svc.get_top_ips(
                RAW_START, NOW, GeoEventFilters(ip_exclude=["1.1.1.1"]), limit=10
            )
        assert len(limited) == 1
        assert all(r.ip_address != "1.1.1.1" for r in excluded)

    async def test_top_ips_cagg_path(self, pg_engine, pg_session_maker, clean_tables):
        await seed_multiday(pg_session_maker)
        await refresh_caggs_range(
            pg_engine, start=NOW - timedelta(days=4), end=NOW + timedelta(hours=1)
        )
        async with pg_session_maker() as session:
            rows = await GeoEventService(session=session).get_top_ips(
                NOW - timedelta(days=3, hours=2), NOW, GeoEventFilters(), limit=10
            )
        assert [(r.ip_address, r.event_count) for r in rows] == [
            ("1.1.1.1", 6), ("2.2.2.2", 3)
        ]

    async def test_top_countries_and_cities(self, pg_session_maker, clean_tables):
        await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            svc = GeoEventService(session=session)
            countries = await svc.get_top_countries(RAW_START, NOW, GeoEventFilters(), limit=10)
            cities = await svc.get_top_cities(RAW_START, NOW, GeoEventFilters(), limit=10)
        assert [(c.country_code, c.event_count, c.unique_ips) for c in countries] == [
            ("NO", 4, 2), ("SE", 2, 1), ("US", 1, 1)
        ]
        assert countries[0].country_name == "Norway"
        # NULL city (US) excluded
        assert [(c.city, c.event_count, c.unique_ips) for c in cities] == [
            ("Oslo", 4, 2), ("Umea", 2, 1)
        ]
        assert cities[0].country_code == "NO"

    async def test_top_countries_cagg_path_exact_uniques(self, pg_engine, pg_session_maker, clean_tables):
        await seed_multiday(pg_session_maker)
        await refresh_caggs_range(
            pg_engine, start=NOW - timedelta(days=4), end=NOW + timedelta(hours=1)
        )
        async with pg_session_maker() as session:
            countries = await GeoEventService(session=session).get_top_countries(
                NOW - timedelta(days=3, hours=2), NOW, GeoEventFilters(), limit=10
            )
        assert [(c.country_code, c.event_count, c.unique_ips) for c in countries] == [
            ("NO", 6, 1), ("SE", 3, 1)
        ]


class TestGeojsonEventCountFilters:
    """New optional IP/hostname filters on GeoLocationRepository
    .get_all_with_event_counts (embedded geo-logs map)."""

    async def test_unchanged_without_new_params(self, pg_session_maker, clean_tables):
        """Map regression guard: omitting the new params keeps old behavior."""
        from geometrikks.domain.geo.repositories import GeoLocationRepository

        await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            rows = await GeoLocationRepository(session=session).get_all_with_event_counts(
                RAW_START, NOW
            )
        assert len(rows) == 3
        assert sum(r.event_count for r in rows) == 7

    async def test_ip_and_hostname_filters_shrink_results(self, pg_session_maker, clean_tables):
        from geometrikks.domain.geo.repositories import GeoLocationRepository

        locs = await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            repo = GeoLocationRepository(session=session)
            by_ip = await repo.get_all_with_event_counts(
                RAW_START, NOW, ip_addresses=["1.1.1.1"]
            )
            by_ip_excl = await repo.get_all_with_event_counts(
                RAW_START, NOW, ip_addresses_exclude=["1.1.1.1"]
            )
            by_host = await repo.get_all_with_event_counts(
                RAW_START, NOW, hostnames=["web1"]
            )
        assert {r.location.id for r in by_ip} == {locs["no"], locs["se"]}
        assert sum(r.event_count for r in by_ip) == 5
        assert {r.location.id for r in by_ip_excl} == {locs["no"], locs["us"]}
        assert sum(r.event_count for r in by_ip_excl) == 2
        assert {r.location.id for r in by_host} == {locs["no"], locs["se"]}
        assert sum(r.event_count for r in by_host) == 5

    async def test_new_filters_force_raw_on_long_range(self, pg_engine, pg_session_maker, clean_tables):
        """The location CAGGs carry no IP/hostname dims: filtered long ranges
        must fall back to raw geo_events and still return correct counts."""
        from geometrikks.domain.geo.repositories import GeoLocationRepository

        locs = await seed_multiday(pg_session_maker)
        start = NOW - timedelta(days=3, hours=2)
        async with pg_session_maker() as session:
            repo = GeoLocationRepository(session=session)
            by_host = await repo.get_all_with_event_counts(start, NOW, hostnames=["web2"])
            by_ip = await repo.get_all_with_event_counts(start, NOW, ip_addresses=["1.1.1.1"])
        assert {r.location.id for r in by_host} == {locs["se"]}
        assert sum(r.event_count for r in by_host) == 3
        assert {r.location.id for r in by_ip} == {locs["no"]}
        assert sum(r.event_count for r in by_ip) == 6


class TestFacets:
    async def test_distinct_sorted_values(self, pg_session_maker, clean_tables):
        await seed_raw(pg_session_maker)
        async with pg_session_maker() as session:
            facets = await GeoEventService(session=session).get_facets()
        assert [(c.code, c.name) for c in facets.countries] == [
            ("NO", "Norway"), ("SE", "Sweden"), ("US", "United States")
        ]
        assert facets.cities == ["Oslo", "Umea"]
        assert facets.hostnames == ["web1", "web2"]
