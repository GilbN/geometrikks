"""Repo-level tests for the analytics top-lists (and later time-series) endpoints.

Tests go through the repositories rather than HTTP so they stay independent
of auth wiring.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from geometrikks.domain.analytics.repositories import AnalyticsFilters, LiveStatsRepository

import pytest

pytestmark = pytest.mark.anyio

# Wall-clock derived, hour-aligned (see test_repositories_pg.py for why).
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def _insert_log(
    session, *, ts, url, user_agent, status=200, bytes_sent=100, rt=0.01,
    ip="10.0.0.1", country=None, country_name=None, city=None
):
    # access_logs is an id-only base: no created_at/updated_at columns.
    await session.execute(text(
        "INSERT INTO access_logs (timestamp, ip_address, method, url, "
        "status_code, bytes_sent, request_time, user_agent, country_code, country_name, city) "
        "VALUES (:ts, :ip, 'GET', :url, :status, :bytes, :rt, :ua, :country, :country_name, :city)"
    ), {
        "ts": ts, "url": url, "status": status, "bytes": bytes_sent, "rt": rt, "ua": user_agent,
        "ip": ip, "country": country, "country_name": country_name, "city": city
    })


async def test_top_urls_ordering_and_math(pg_session_maker, clean_tables):
    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        for _ in range(5):
            await _insert_log(session, ts=ts, url="/busy", user_agent="bot/1.0", bytes_sent=200)
        await _insert_log(session, ts=ts, url="/busy", user_agent="bot/1.0", status=500, bytes_sent=200)
        for _ in range(2):
            await _insert_log(session, ts=ts, url="/quiet", user_agent="curl/8.0")
        await session.commit()

    async with pg_session_maker() as session:
        rows = await LiveStatsRepository(session=session).get_top_urls(
            NOW - timedelta(hours=2), NOW, limit=10
        )

    assert [r.url for r in rows] == ["/busy", "/quiet"]
    busy = rows[0]
    assert busy.hits == 6
    assert busy.error_hits == 1
    assert busy.total_bytes == 6 * 200
    assert 0.005 < busy.avg_request_time < 0.02


async def test_top_user_agents_ordering(pg_session_maker, clean_tables):
    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        for _ in range(3):
            await _insert_log(session, ts=ts, url="/a", user_agent="bot/1.0")
        await _insert_log(session, ts=ts, url="/a", user_agent="curl/8.0")
        await session.commit()

    async with pg_session_maker() as session:
        rows = await LiveStatsRepository(session=session).get_top_user_agents(
            NOW - timedelta(hours=2), NOW, limit=10
        )

    assert [(r.user_agent, r.hits) for r in rows] == [("bot/1.0", 3), ("curl/8.0", 1)]


async def test_top_lists_respect_limit_and_window(pg_session_maker, clean_tables):
    inside = NOW - timedelta(hours=1)
    outside = NOW - timedelta(hours=30)
    async with pg_session_maker() as session:
        for i in range(3):
            await _insert_log(session, ts=inside, url=f"/u{i}", user_agent=f"ua{i}")
        await _insert_log(session, ts=outside, url="/old", user_agent="old-ua")
        await session.commit()

    async with pg_session_maker() as session:
        repo = LiveStatsRepository(session=session)
        urls = await repo.get_top_urls(NOW - timedelta(hours=2), NOW, limit=2)
        agents = await repo.get_top_user_agents(NOW - timedelta(hours=2), NOW, limit=10)

    assert len(urls) == 2
    assert all(r.url != "/old" for r in urls)
    assert all(r.user_agent != "old-ua" for r in agents)


async def test_time_series_methods_survive_sub_24h_ranges(pg_session_maker, clean_tables):
    """Regression: RAW granularity used to build nonexistent summary_raw_stats /
    geo_summary_raw_stats table names. Sub-24h ranges must clamp to hourly."""
    from geometrikks.domain.analytics.repositories import SummaryStatsRepository

    async with pg_session_maker() as session:
        repo = SummaryStatsRepository(session=session)
        series = await repo.get_time_series(NOW - timedelta(hours=2), NOW)
        geo_series = await repo.get_geo_time_series(NOW - timedelta(hours=2), NOW)

    assert isinstance(series, list)
    assert isinstance(geo_series, list)


async def test_get_time_series_granularity_override(pg_session_maker, clean_tables):
    """Explicit granularity overrides auto-routing: same data, different bucket
    counts (issue #14 - user-selectable chart granularity)."""
    from geometrikks.domain.analytics.repositories import StatsGranularity, SummaryStatsRepository

    # Midnight of yesterday: guaranteed in the past regardless of wall-clock hour,
    # and both inserts stay within the same calendar day.
    base_day = (NOW - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    ts1 = base_day + timedelta(hours=2)
    ts2 = base_day + timedelta(hours=4)

    async with pg_session_maker() as session:
        await _insert_log(session, ts=ts1, url="/a", user_agent="ua")
        await _insert_log(session, ts=ts2, url="/b", user_agent="ua")
        await session.commit()

    query_start = base_day
    query_end = base_day + timedelta(days=2)

    async with pg_session_maker() as session:
        repo = SummaryStatsRepository(session=session)
        daily_rows = await repo.get_time_series(query_start, query_end, granularity=StatsGranularity.DAILY)
        hourly_rows = await repo.get_time_series(query_start, query_end, granularity=StatsGranularity.HOURLY)

    assert len(daily_rows) == 1
    assert daily_rows[0].bucket == base_day
    assert daily_rows[0].total_requests == 2

    assert len(hourly_rows) == 2
    assert {r.bucket for r in hourly_rows} == {ts1, ts2}


async def test_time_series_total_bytes_is_int(pg_session_maker, clean_tables):
    """SUM(bigint) returns numeric/Decimal; the repo must coerce to int so
    JSON serialization emits a number, not a string (issue #14 bandwidth cap)."""
    from geometrikks.domain.analytics.repositories import SummaryStatsRepository

    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        await _insert_log(session, ts=ts, url="/big", user_agent="x", bytes_sent=5_000_000_000)
        await session.commit()

    async with pg_session_maker() as session:
        rows = await SummaryStatsRepository(session=session).get_time_series(
            NOW - timedelta(days=2), NOW  # > 24h so it hits the hourly CAGG path
        )
        summary = await SummaryStatsRepository(session=session).get_summary(
            NOW - timedelta(days=2), NOW
        )

    assert rows, "expected at least one bucket (real-time aggregation)"
    assert all(type(r.total_bytes) is int for r in rows)
    assert summary is not None
    assert type(summary.total_bytes) is int


async def test_top_ips_ordering_and_math(pg_session_maker, clean_tables):
    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        for _ in range(3):
            await _insert_log(session, ts=ts, url="/a", user_agent="x",
                              ip="1.1.1.1", country="NO", city="Oslo", bytes_sent=100)
        await _insert_log(session, ts=ts, url="/a", user_agent="x",
                          ip="1.1.1.1", country="NO", city="Oslo", status=500)
        await _insert_log(session, ts=ts, url="/b", user_agent="x",
                          ip="2.2.2.2", country="SE", city="Umea")
        await session.commit()

    async with pg_session_maker() as session:
        rows = await LiveStatsRepository(session=session).get_top_ips(
            NOW - timedelta(hours=2), NOW, limit=10
        )

    assert [r.ip_address for r in rows] == ["1.1.1.1", "2.2.2.2"]
    top = rows[0]
    assert (top.hits, top.error_hits, top.country_code, top.city) == (4, 1, "NO", "Oslo")
    assert type(top.total_bytes) is int


async def test_top_countries_and_cities(pg_session_maker, clean_tables):
    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        for ip in ("1.1.1.1", "1.1.1.2"):
            await _insert_log(session, ts=ts, url="/a", user_agent="x",
                              ip=ip, country="NO", country_name="Norway", city="Oslo")
        await _insert_log(session, ts=ts, url="/b", user_agent="x",
                          ip="2.2.2.2", country="SE", country_name="Sweden", city="Umea")
        await _insert_log(session, ts=ts, url="/c", user_agent="x", ip="3.3.3.3")  # no geo
        await session.commit()

    async with pg_session_maker() as session:
        repo = LiveStatsRepository(session=session)
        countries = await repo.get_top_countries(NOW - timedelta(hours=2), NOW, limit=10)
        cities = await repo.get_top_cities(NOW - timedelta(hours=2), NOW, limit=10)

    assert [(c.country_code, c.hits, c.unique_ips) for c in countries] == [
        ("NO", 2, 2), ("SE", 1, 1)
    ]
    assert countries[0].country_name == "Norway"
    assert [(c.city, c.hits) for c in cities] == [("Oslo", 2), ("Umea", 1)]


async def test_filtered_time_series_and_top_urls(pg_session_maker, clean_tables):
    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        for _ in range(3):
            await _insert_log(session, ts=ts, url="/no", user_agent="x",
                              ip="1.1.1.1", country="NO", city="Oslo")
        await _insert_log(session, ts=ts, url="/se", user_agent="x",
                          ip="2.2.2.2", country="SE", city="Umea")
        await session.commit()

    f_country = AnalyticsFilters(country_codes=["NO"])
    f_ip = AnalyticsFilters(ip_addresses=["2.2.2.2"])

    async with pg_session_maker() as session:
        repo = LiveStatsRepository(session=session)
        rows = await repo.get_time_series(
            NOW - timedelta(hours=2), NOW, bucket_interval="1 hour", filters=f_country
        )
        urls = await repo.get_top_urls(NOW - timedelta(hours=2), NOW, limit=10, filters=f_ip)

    assert sum(r.total_requests for r in rows) == 3
    assert [u.url for u in urls] == ["/se"]


async def test_top_ips_honors_ip_exclude(pg_session_maker, clean_tables):
    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        for _ in range(3):
            await _insert_log(session, ts=ts, url="/a", user_agent="bot/1.0", ip="10.0.0.1")
        await _insert_log(session, ts=ts, url="/a", user_agent="bot/1.0", ip="10.0.0.2")
        await session.commit()

    async with pg_session_maker() as session:
        rows = await LiveStatsRepository(session=session).get_top_ips(
            NOW - timedelta(hours=2), NOW, limit=10,
            filters=AnalyticsFilters(ip_exclude=["10.0.0.1"]),
        )

    assert [(str(r.ip_address), r.hits) for r in rows] == [("10.0.0.2", 1)]


async def test_time_series_totals_drop_by_excluded_ip(pg_session_maker, clean_tables):
    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        for _ in range(4):
            await _insert_log(session, ts=ts, url="/a", user_agent="bot/1.0", ip="10.0.0.1")
        await _insert_log(session, ts=ts, url="/a", user_agent="bot/1.0", ip="10.0.0.2")
        await session.commit()

    async with pg_session_maker() as session:
        repo = LiveStatsRepository(session=session)
        unfiltered = await repo.get_time_series(
            NOW - timedelta(hours=2), NOW, bucket_interval="1 hour",
            filters=AnalyticsFilters(),
        )
        filtered = await repo.get_time_series(
            NOW - timedelta(hours=2), NOW, bucket_interval="1 hour",
            filters=AnalyticsFilters(ip_exclude=["10.0.0.1"]),
        )

    assert sum(r.total_requests for r in unfiltered) == 5
    assert sum(r.total_requests for r in filtered) == 1


async def _insert_asn_log(session, *, ts, asn, asn_org, bytes_sent=100):
    await session.execute(text(
        "INSERT INTO access_logs (timestamp, ip_address, method, url, "
        "status_code, bytes_sent, request_time, autonomous_system_number, "
        "autonomous_system_organization) "
        "VALUES (:ts, '10.0.0.1', 'GET', '/', 200, :bytes, 0.01, :asn, :org)"
    ), {"ts": ts, "bytes": bytes_sent, "asn": asn, "org": asn_org})


async def test_top_asns_ordering_and_org(pg_session_maker, clean_tables):
    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        for _ in range(3):
            await _insert_asn_log(session, ts=ts, asn=24940, asn_org="Hetzner Online GmbH", bytes_sent=200)
        await _insert_asn_log(session, ts=ts, asn=2119, asn_org="Telenor Norge AS")
        # NULL-ASN rows must not appear in the grouping.
        await _insert_log(session, ts=ts, url="/x", user_agent="curl/8.0")
        await session.commit()

    async with pg_session_maker() as session:
        rows = await LiveStatsRepository(session=session).get_top_asns(
            NOW - timedelta(hours=2), NOW
        )

    assert [(r.asn, r.organization, r.hits, r.total_bytes) for r in rows] == [
        (24940, "Hetzner Online GmbH", 3, 600),
        (2119, "Telenor Norge AS", 1, 100),
    ]


async def test_apply_asn_mapping_fills_only_null_rows(pg_engine, pg_session_maker, clean_tables):
    from geometrikks.cli import _apply_asn_mapping

    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        # Two NULL-ASN rows for 10.0.0.1, one already-stamped row that must
        # not be overwritten, and one NULL row whose IP is not in the mapping.
        await _insert_log(session, ts=ts, url="/a", user_agent="x")
        await _insert_log(session, ts=ts, url="/b", user_agent="x")
        await _insert_asn_log(session, ts=ts, asn=999, asn_org="Stamped Org")
        await _insert_log(session, ts=ts, url="/c", user_agent="x", ip="10.9.9.9")
        await session.commit()

    updated = await _apply_asn_mapping(pg_engine, [
        {"ip": "10.0.0.1", "asn": 24940, "org": "Hetzner Online GmbH"},
    ])
    assert updated == 2

    async with pg_session_maker() as session:
        rows = (await session.execute(text(
            "SELECT host(ip_address), autonomous_system_number, autonomous_system_organization "
            "FROM access_logs ORDER BY url"
        ))).all()

    by_row = {(r[0], r[1], r[2]) for r in rows}
    assert ("10.0.0.1", 24940, "Hetzner Online GmbH") in by_row
    assert ("10.0.0.1", 999, "Stamped Org") in by_row
    assert ("10.9.9.9", None, None) in by_row

async def test_request_totals_count_unenriched_rows(pg_session_maker, clean_tables):
    """The /top-asns denominator must include NULL-ASN rows.

    Regression: the Traffic origin card divided by the ASN category sum, so
    an install whose history predates enrichment read as "100% hosting".
    """
    from geometrikks.domain.analytics.repositories import SummaryStatsRepository

    ts = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        await _insert_asn_log(session, ts=ts, asn=24940, asn_org="Hetzner Online GmbH", bytes_sent=200)
        for _ in range(3):  # pre-feature history: no ASN data
            await _insert_log(session, ts=ts, url="/old", user_agent="x", bytes_sent=100)
        await session.commit()

    async with pg_session_maker() as session:
        repo = SummaryStatsRepository(session=session)
        asn_rows = await repo.get_top_asns(NOW - timedelta(hours=2), NOW)
        total_requests, total_bytes = await repo.get_request_totals(
            NOW - timedelta(hours=2), NOW
        )

    assert sum(r.hits for r in asn_rows) == 1, "ASN queries only see tagged rows"
    assert total_requests == 4, "totals must include the unenriched rows"
    assert total_bytes == 500


async def test_request_totals_match_asn_window_on_misaligned_ranges(
    pg_engine, pg_session_maker, clean_tables
):
    """Totals and ASN hits must cover the same window above 24h.

    Regression: the totals came from get_summary, whose CAGG read floors the
    start bucket and includes the whole end bucket, while get_top_asns is
    stitched to the exact range. On a 12:30 -> 12:30 window the totals
    carried traffic from outside it, which the UI showed as unenriched.
    """
    from geometrikks.domain.analytics.repositories import SummaryStatsRepository
    from geometrikks.server.timescale import refresh_caggs_range

    start = NOW - timedelta(hours=48) + timedelta(minutes=30)
    end = NOW - timedelta(minutes=30)
    async with pg_session_maker() as session:
        # Same hourly bucket as `start`, but before it: must not count.
        await _insert_asn_log(session, ts=start - timedelta(minutes=10), asn=1, asn_org="Outside")
        # Same hourly bucket as `end`, but after it: must not count.
        await _insert_asn_log(session, ts=end + timedelta(minutes=10), asn=1, asn_org="Outside")
        # Inside the window: one in the partial head bucket, one in a whole bucket.
        await _insert_asn_log(session, ts=start + timedelta(minutes=5), asn=2, asn_org="Inside")
        await _insert_asn_log(session, ts=NOW - timedelta(hours=24), asn=2, asn_org="Inside")
        await session.commit()
    await refresh_caggs_range(
        pg_engine,
        start=NOW - timedelta(hours=50),
        end=NOW + timedelta(hours=1),
        caggs=["summary_hourly_stats", "asn_hourly_stats"],
    )

    async with pg_session_maker() as session:
        repo = SummaryStatsRepository(session=session)
        asn_rows = await repo.get_top_asns(start, end)
        total_requests, _ = await repo.get_request_totals(start, end)

    assert sum(r.hits for r in asn_rows) == 2
    assert total_requests == 2, "totals must not include the bucket slop outside the window"


async def test_iter_null_asn_ips_pages_without_gaps_or_repeats(pg_engine, pg_session_maker, clean_tables):
    """Keyset pagination must cover every distinct NULL-ASN IP exactly once."""
    from geometrikks.cli import _iter_null_asn_ips

    ts = NOW - timedelta(hours=1)
    ips = [f"10.0.0.{i}" for i in range(1, 8)]
    async with pg_session_maker() as session:
        for ip in ips:
            for _ in range(2):  # duplicates must collapse
                await _insert_log(session, ts=ts, url="/a", user_agent="x", ip=ip)
        # A stamped row's IP must not appear: it needs no backfill.
        await _insert_asn_log(session, ts=ts, asn=24940, asn_org="Hetzner Online GmbH")
        await session.commit()

    pages = [page async for page in _iter_null_asn_ips(pg_engine, chunk_size=3)]

    assert len(pages) > 1, "chunk_size=3 over 7 IPs must paginate"
    seen = [ip for page in pages for ip in page]
    assert sorted(seen) == sorted(ips)
    assert len(seen) == len(set(seen))
