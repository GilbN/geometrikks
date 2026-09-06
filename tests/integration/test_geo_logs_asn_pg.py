"""ASN on geo events: backfill, aggregates, filters, facets (real TimescaleDB)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from tests.integration.test_geo_logs_pg import _insert_location

pytestmark = pytest.mark.anyio

NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
RAW_START = NOW - timedelta(hours=23)


async def _insert_event(
    session, *, ts, ip: str, location_id: int, hostname: str = "web1",
    asn: int | None = None, org: str | None = None, n: int = 1,
) -> None:
    for _ in range(n):
        await session.execute(text(
            "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id, "
            " autonomous_system_number, autonomous_system_organization) "
            "VALUES (:ts, :ip, :hostname, :loc, :asn, :org)"
        ), {"ts": ts, "ip": ip, "hostname": hostname, "loc": location_id, "asn": asn, "org": org})


async def _one_location(session) -> int:
    return await _insert_location(
        session, geohash="asnloc", latitude=59.91, longitude=10.75,
        country_code="NO", country_name="Norway", city="Oslo",
    )


async def test_apply_asn_mapping_on_geo_events_fills_only_null_rows(pg_engine, pg_session_maker, clean_tables):
    from geometrikks.cli import _apply_asn_mapping, _iter_null_asn_ips

    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        loc = await _one_location(session)
        await _insert_event(session, ts=ts, ip="10.0.0.1", location_id=loc, n=2)
        await _insert_event(session, ts=ts, ip="10.0.0.1", location_id=loc, asn=999, org="Stamped Org")
        await _insert_event(session, ts=ts, ip="10.9.9.9", location_id=loc)
        await session.commit()

    pages = [page async for page in _iter_null_asn_ips(pg_engine, table="geo_events", chunk_size=10)]
    assert pages == [["10.0.0.1", "10.9.9.9"]]

    updated = await _apply_asn_mapping(pg_engine, [
        {"ip": "10.0.0.1", "asn": 24940, "org": "Hetzner Online GmbH"},
    ], table="geo_events")
    assert updated == 2

    async with pg_session_maker() as session:
        rows = (await session.execute(text(
            "SELECT host(ip_address), autonomous_system_number, autonomous_system_organization "
            "FROM geo_events"
        ))).all()
    assert sorted((r[0], r[1], r[2]) for r in rows) == [
        ("10.0.0.1", 999, "Stamped Org"),
        ("10.0.0.1", 24940, "Hetzner Online GmbH"),
        ("10.0.0.1", 24940, "Hetzner Online GmbH"),
        ("10.9.9.9", None, None),
    ]


from geometrikks.domain.geo.schemas import GeoEventFilters
from geometrikks.domain.geo.services import GeoEventService
from geometrikks.server.timescale import refresh_caggs_range


async def seed_asn_raw(session_maker) -> int:
    """Last 24h: 1.1.1.1 x3 (AS1221), 2.2.2.2 x2 (AS24940, hosting), 3.3.3.3 x1 (no ASN)."""
    t1 = NOW - timedelta(hours=3)
    async with session_maker() as session:
        loc = await _one_location(session)
        await _insert_event(session, ts=t1, ip="1.1.1.1", location_id=loc, asn=1221, org="Telstra Pty Ltd", n=3)
        await _insert_event(session, ts=t1, ip="2.2.2.2", location_id=loc, asn=24940, org="Hetzner Online GmbH", n=2)
        await _insert_event(session, ts=t1, ip="3.3.3.3", location_id=loc)
        await session.commit()
    return loc


async def seed_asn_multiday(session_maker) -> int:
    """Same three IPs, one event set per day over 3 days (HOURLY routing on >24h)."""
    async with session_maker() as session:
        loc = await _one_location(session)
        for day in range(3):
            ts = NOW - timedelta(days=day, hours=1)
            await _insert_event(session, ts=ts, ip="1.1.1.1", location_id=loc, asn=1221, org="Telstra Pty Ltd", n=2)
            await _insert_event(session, ts=ts, ip="2.2.2.2", location_id=loc, asn=24940, org="Hetzner Online GmbH")
            await _insert_event(session, ts=ts, ip="3.3.3.3", location_id=loc)
        await session.commit()
    return loc


MULTIDAY_START = NOW - timedelta(days=3, hours=2)


async def _refresh(pg_engine) -> None:
    await refresh_caggs_range(pg_engine, start=NOW - timedelta(days=4), end=NOW + timedelta(hours=1))


class TestTopIpsCarryAsn:
    async def test_raw_path(self, pg_session_maker, clean_tables):
        await seed_asn_raw(pg_session_maker)
        async with pg_session_maker() as session:
            rows = await GeoEventService(session=session).get_top_ips(RAW_START, NOW, GeoEventFilters(), limit=10)
        assert [(r.ip_address, r.asn, r.as_organization) for r in rows] == [
            ("1.1.1.1", 1221, "Telstra Pty Ltd"),
            ("2.2.2.2", 24940, "Hetzner Online GmbH"),
            ("3.3.3.3", None, None),
        ]

    async def test_cagg_path(self, pg_engine, pg_session_maker, clean_tables):
        await seed_asn_multiday(pg_session_maker)
        await _refresh(pg_engine)
        async with pg_session_maker() as session:
            rows = await GeoEventService(session=session).get_top_ips(MULTIDAY_START, NOW, GeoEventFilters(), limit=10)
        assert [(r.ip_address, r.event_count, r.asn) for r in rows] == [
            ("1.1.1.1", 6, 1221), ("2.2.2.2", 3, 24940), ("3.3.3.3", 3, None),
        ]


class TestTopAsns:
    async def test_raw_path_excludes_null_and_classifies(self, pg_session_maker, clean_tables):
        await seed_asn_raw(pg_session_maker)
        async with pg_session_maker() as session:
            rows = await GeoEventService(session=session).get_top_asns(RAW_START, NOW, GeoEventFilters(), limit=10)
        assert [(r.asn, r.organization, r.category, r.event_count, r.unique_ips) for r in rows] == [
            (1221, "Telstra Pty Ltd", "other", 3, 1),
            (24940, "Hetzner Online GmbH", "hosting", 2, 1),
        ]

    async def test_cagg_path_matches_raw_scan(self, pg_engine, pg_session_maker, clean_tables):
        await seed_asn_multiday(pg_session_maker)
        await _refresh(pg_engine)
        async with pg_session_maker() as session:
            expected = (await session.execute(text(
                "SELECT autonomous_system_number AS asn, COUNT(*) AS events, COUNT(DISTINCT ip_address) AS uips "
                "FROM geo_events WHERE timestamp >= :s AND timestamp < :e "
                "  AND autonomous_system_number IS NOT NULL "
                "GROUP BY 1 ORDER BY events DESC, asn"
            ), {"s": MULTIDAY_START, "e": NOW})).all()
            rows = await GeoEventService(session=session).get_top_asns(MULTIDAY_START, NOW, GeoEventFilters(), limit=10)
        assert [(r.asn, r.event_count, r.unique_ips) for r in rows] == [
            (e.asn, e.events, e.uips) for e in expected
        ]
        assert rows[0].organization == "Telstra Pty Ltd"

    async def test_limit(self, pg_session_maker, clean_tables):
        await seed_asn_raw(pg_session_maker)
        async with pg_session_maker() as session:
            rows = await GeoEventService(session=session).get_top_asns(RAW_START, NOW, GeoEventFilters(), limit=1)
        assert [r.asn for r in rows] == [1221]


class TestAsnFilters:
    async def test_include_on_raw_path(self, pg_session_maker, clean_tables):
        await seed_asn_raw(pg_session_maker)
        async with pg_session_maker() as session:
            rows = await GeoEventService(session=session).get_top_ips(
                RAW_START, NOW, GeoEventFilters(asn_include=[24940]), limit=10
            )
        assert [r.ip_address for r in rows] == ["2.2.2.2"]

    async def test_exclude_keeps_rows_without_asn_on_raw_path(self, pg_session_maker, clean_tables):
        await seed_asn_raw(pg_session_maker)
        async with pg_session_maker() as session:
            rows = await GeoEventService(session=session).get_top_ips(
                RAW_START, NOW, GeoEventFilters(asn_exclude=[1221]), limit=10
            )
        assert [r.ip_address for r in rows] == ["2.2.2.2", "3.3.3.3"]

    async def test_exclude_keeps_rows_without_asn_on_cagg_path(self, pg_engine, pg_session_maker, clean_tables):
        await seed_asn_multiday(pg_session_maker)
        await _refresh(pg_engine)
        async with pg_session_maker() as session:
            svc = GeoEventService(session=session)
            top = await svc.get_top_ips(MULTIDAY_START, NOW, GeoEventFilters(asn_exclude=[1221]), limit=10)
            countries = await svc.get_top_countries(MULTIDAY_START, NOW, GeoEventFilters(asn_include=[24940]), limit=10)
            summary = await svc.get_summary(MULTIDAY_START, NOW, GeoEventFilters(asn_exclude=[1221, 24940]))
        assert [(r.ip_address, r.event_count) for r in top] == [("2.2.2.2", 3), ("3.3.3.3", 3)]
        assert [(c.country_code, c.event_count, c.unique_ips) for c in countries] == [("NO", 3, 1)]
        assert (summary.total_events, summary.unique_ips) == (3, 1)


class TestGroupedRowsCarryAsn:
    async def test_fields_and_sort(self, pg_session_maker, clean_tables):
        await seed_asn_raw(pg_session_maker)
        async with pg_session_maker() as session:
            rows, total = await GeoEventService(session=session).get_grouped_logs(
                RAW_START, NOW, GeoEventFilters(), limit=10, offset=0, order_by="asn", sort_order="asc"
            )
        assert total == 3
        assert [(r.ip_address, r.asn, r.as_organization) for r in rows] == [
            ("1.1.1.1", 1221, "Telstra Pty Ltd"),
            ("2.2.2.2", 24940, "Hetzner Online GmbH"),
            ("3.3.3.3", None, None),
        ], "NULLs sink on asc too"

    async def test_cagg_path(self, pg_engine, pg_session_maker, clean_tables):
        await seed_asn_multiday(pg_session_maker)
        await _refresh(pg_engine)
        async with pg_session_maker() as session:
            rows, _ = await GeoEventService(session=session).get_grouped_logs(
                MULTIDAY_START, NOW, GeoEventFilters(), limit=10, offset=0
            )
        assert {(r.ip_address, r.asn) for r in rows} == {("1.1.1.1", 1221), ("2.2.2.2", 24940), ("3.3.3.3", None)}


class TestAsnFacet:
    async def test_reads_the_access_log_asn_rollup(self, pg_engine, pg_session_maker, clean_tables):
        ts = NOW - timedelta(hours=2)
        async with pg_session_maker() as session:
            for asn, org in ((24940, "Hetzner Online GmbH"), (1221, "Telstra Pty Ltd"), (24940, "Hetzner Online GmbH")):
                await session.execute(text(
                    "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, bytes_sent, "
                    " autonomous_system_number, autonomous_system_organization) "
                    "VALUES (:ts, '10.0.0.1', 'GET', '/', 200, 10, :asn, :org)"
                ), {"ts": ts, "asn": asn, "org": org})
            await session.commit()
        await refresh_caggs_range(
            pg_engine, start=NOW - timedelta(days=1), end=NOW + timedelta(hours=1),
            caggs=["asn_daily_stats", "hostname_daily_stats"],
        )
        async with pg_session_maker() as session:
            facets = await GeoEventService(session=session).get_facets()
        assert [(f.asn, f.organization) for f in facets.asns] == [
            (24940, "Hetzner Online GmbH"), (1221, "Telstra Pty Ltd"),
        ]


class TestGeojsonAsnFilters:
    async def test_include_and_exclude_shrink_results(self, pg_session_maker, clean_tables):
        from geometrikks.domain.geo.repositories import GeoLocationRepository

        loc = await seed_asn_raw(pg_session_maker)
        async with pg_session_maker() as session:
            repo = GeoLocationRepository(session=session)
            only_hetzner = await repo.get_all_with_event_counts(RAW_START, NOW, asns=[24940])
            without_telstra = await repo.get_all_with_event_counts(RAW_START, NOW, asns_exclude=[1221])
            none = await repo.get_all_with_event_counts(RAW_START, NOW, asns=[65000])
        assert [(r.location.id, r.event_count) for r in only_hetzner] == [(loc, 2)]
        assert [(r.location.id, r.event_count) for r in without_telstra] == [(loc, 3)], "the no-ASN row survives an exclude"
        assert none == []

    async def test_asn_filter_forces_raw_on_long_range(self, pg_engine, pg_session_maker, clean_tables):
        """The location CAGGs carry no ASN, so a filtered long range must read geo_events."""
        from geometrikks.domain.geo.repositories import GeoLocationRepository

        loc = await seed_asn_multiday(pg_session_maker)
        # No CAGG refresh on purpose: a CAGG read would see nothing.
        async with pg_session_maker() as session:
            rows = await GeoLocationRepository(session=session).get_all_with_event_counts(
                MULTIDAY_START, NOW, asns=[1221]
            )
        assert [(r.location.id, r.event_count) for r in rows] == [(loc, 6)]
