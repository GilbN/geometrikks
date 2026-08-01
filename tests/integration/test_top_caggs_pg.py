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
    "host_daily_stats",
    "hostname_daily_stats",
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


from geometrikks.domain.analytics.repositories import (
    AnalyticsFilters,
    LiveStatsRepository,
    SummaryStatsRepository,
)

import pytest

pytestmark = pytest.mark.anyio


async def _insert_log(
    session, *, ts, url="/page", user_agent="ua/1.0", status=200,
    bytes_sent=100, rt=0.25, ip="10.0.0.1",
    country=None, country_name=None, city=None, host=None,
):
    # access_logs is an id-only base: no created_at/updated_at columns.
    # rt values (0.25, 0.5) are chosen to be exact in binary floating point
    # so sums and divisions stay exact, and are varied across buckets so
    # weighted-average (correct SUM/SUM) vs unweighted-average regressions
    # are caught (e.g., AVG(request_time) per bucket then AVG those).
    await session.execute(text(
        "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, "
        "bytes_sent, request_time, user_agent, country_code, country_name, city, host) "
        "VALUES (:ts, :ip, 'GET', :url, :status, :bytes, :rt, :ua, "
        ":country, :country_name, :city, :host)"
    ), {
        "ts": ts, "url": url, "status": status, "bytes": bytes_sent, "rt": rt,
        "ua": user_agent, "ip": ip, "country": country,
        "country_name": country_name, "city": city, "host": host,
    })


async def seed_boundary_logs(session_maker) -> None:
    """Logs straddling the misaligned [B_START, B_END) window.

    9.9.9.9 / 8.8.8.8 rows sit OUTSIDE the window but inside the same hour
    buckets as its edges: exactly what bucket-flooring would wrongly include.
    In-window totals: /a 4 hits (1 error, 800 bytes) from 1.1.1.1 (NO/Oslo),
    /b 3 hits (150 bytes) from 2.2.2.2 (SE/Umea), plus one malformed line
    (NULL url/user_agent/geo) from 7.7.7.7 that only top-IPs may count.
    """
    async with session_maker() as session:
        # Head edge: before the window, same hour bucket as B_START.
        await _insert_log(
            session, ts=B_START - timedelta(minutes=20), ip="9.9.9.9", url="/edge",
            user_agent="edge/1.0", country="DE", country_name="Germany", city="Berlin",
        )
        # In window, day 3.
        await _insert_log(
            session, ts=B_START + timedelta(minutes=10), ip="1.1.1.1", url="/a",
            user_agent="bot/1.0", bytes_sent=200, rt=0.5,
            country="NO", country_name="Norway", city="Oslo",
        )
        # In window, day 2: three /a hits, one is a 500.
        for status in (200, 200, 500):
            await _insert_log(
                session, ts=NOW - timedelta(days=2), ip="1.1.1.1", url="/a",
                user_agent="bot/1.0", status=status, bytes_sent=200,
                country="NO", country_name="Norway", city="Oslo",
            )
        # In window, day 1 + near the tail.
        for ts in (NOW - timedelta(days=1), NOW - timedelta(days=1), B_END - timedelta(minutes=10)):
            await _insert_log(
                session, ts=ts, ip="2.2.2.2", url="/b",
                user_agent="curl/8.0", bytes_sent=50,
                country="SE", country_name="Sweden", city="Umea",
            )
        # In window: a malformed line (no URL, no UA, no geo) - counted by
        # top-IPs, excluded from top-URLs/user-agents/countries/cities.
        await _insert_log(
            session, ts=NOW - timedelta(days=1), ip="7.7.7.7", url=None, user_agent=None,
        )
        # Tail edge: after the window, same hour bucket as B_END.
        await _insert_log(
            session, ts=B_END + timedelta(minutes=10), ip="8.8.8.8", url="/edge",
            user_agent="edge/1.0", country="US", country_name="United States", city="NYC",
        )
        await session.commit()


async def _refresh_all(pg_engine) -> None:
    await refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=4), end=NOW + timedelta(hours=1)
    )


class TestTopUrlsParity:
    async def test_matches_raw_scan_and_excludes_edges(self, pg_engine, pg_session_maker, clean_tables):
        await seed_boundary_logs(pg_session_maker)
        await _refresh_all(pg_engine)
        async with pg_session_maker() as session:
            routed = await SummaryStatsRepository(session=session).get_top_urls(B_START, B_END)
            raw = await LiveStatsRepository(session=session).get_top_urls(B_START, B_END)
        assert routed == raw
        assert [(r.url, r.hits, r.error_hits, r.total_bytes) for r in routed] == [
            ("/a", 4, 1, 800),
            ("/b", 3, 0, 150),
        ], "/edge rows are outside the window"
        assert routed[0].avg_request_time == 0.3125
        assert routed[0].avg_request_time == raw[0].avg_request_time


class TestTopUserAgentsParity:
    async def test_matches_raw_scan_and_excludes_edges(self, pg_engine, pg_session_maker, clean_tables):
        await seed_boundary_logs(pg_session_maker)
        await _refresh_all(pg_engine)
        async with pg_session_maker() as session:
            routed = await SummaryStatsRepository(session=session).get_top_user_agents(B_START, B_END)
            raw = await LiveStatsRepository(session=session).get_top_user_agents(B_START, B_END)
        assert routed == raw
        assert [(r.user_agent, r.hits) for r in routed] == [
            ("bot/1.0", 4),
            ("curl/8.0", 3),
        ]


class TestTopIpsCountriesCitiesParity:
    async def test_top_ips_matches_raw_scan(self, pg_engine, pg_session_maker, clean_tables):
        await seed_boundary_logs(pg_session_maker)
        await _refresh_all(pg_engine)
        async with pg_session_maker() as session:
            routed = await SummaryStatsRepository(session=session).get_top_ips(B_START, B_END)
            raw = await LiveStatsRepository(session=session).get_top_ips(B_START, B_END)
        assert routed == raw
        assert [(r.ip_address, r.hits, r.error_hits, r.total_bytes, r.country_code, r.city) for r in routed] == [
            ("1.1.1.1", 4, 1, 800, "NO", "Oslo"),
            ("2.2.2.2", 3, 0, 150, "SE", "Umea"),
            ("7.7.7.7", 1, 0, 100, None, None),
        ], "edge IPs 9.9.9.9 / 8.8.8.8 are outside the window; NULL-geo IP counts"

    async def test_top_countries_matches_raw_scan(self, pg_engine, pg_session_maker, clean_tables):
        await seed_boundary_logs(pg_session_maker)
        await _refresh_all(pg_engine)
        async with pg_session_maker() as session:
            routed = await SummaryStatsRepository(session=session).get_top_countries(B_START, B_END)
            raw = await LiveStatsRepository(session=session).get_top_countries(B_START, B_END)
        assert routed == raw
        assert [(r.country_code, r.country_name, r.hits, r.unique_ips) for r in routed] == [
            ("NO", "Norway", 4, 1),
            ("SE", "Sweden", 3, 1),
        ]

    async def test_top_cities_matches_raw_scan(self, pg_engine, pg_session_maker, clean_tables):
        await seed_boundary_logs(pg_session_maker)
        await _refresh_all(pg_engine)
        async with pg_session_maker() as session:
            routed = await SummaryStatsRepository(session=session).get_top_cities(B_START, B_END)
            raw = await LiveStatsRepository(session=session).get_top_cities(B_START, B_END)
        assert routed == raw
        assert [(r.city, r.country_code, r.hits, r.unique_ips) for r in routed] == [
            ("Oslo", "NO", 4, 1),
            ("Umea", "SE", 3, 1),
        ]

    async def test_filtered_top_ips_stays_on_cagg_and_matches_raw(self, pg_engine, pg_session_maker, clean_tables):
        """Country filter on a >24h range: CAGG path, identical to raw."""
        await seed_boundary_logs(pg_session_maker)
        await _refresh_all(pg_engine)
        flt = AnalyticsFilters(country_codes=["NO"])
        async with pg_session_maker() as session:
            routed = await SummaryStatsRepository(session=session).get_top_ips(B_START, B_END, filters=flt)
            raw = await LiveStatsRepository(session=session).get_top_ips(B_START, B_END, filters=flt)
        assert routed == raw
        assert [(r.ip_address, r.hits) for r in routed] == [("1.1.1.1", 4)]

    async def test_ip_exclude_filter_matches_raw(self, pg_engine, pg_session_maker, clean_tables):
        await seed_boundary_logs(pg_session_maker)
        await _refresh_all(pg_engine)
        flt = AnalyticsFilters(ip_exclude=["1.1.1.1"])
        async with pg_session_maker() as session:
            routed = await SummaryStatsRepository(session=session).get_top_countries(B_START, B_END, filters=flt)
            raw = await LiveStatsRepository(session=session).get_top_countries(B_START, B_END, filters=flt)
        assert routed == raw
        assert [(r.country_code, r.hits) for r in routed] == [("SE", 3)]


class TestTieOrdering:
    """Rows with equal hit counts must order deterministically and identically
    on both paths. Observed on real data: without a tie-break key, tied rows
    shuffled between the CAGG-stitched and raw plans."""

    async def test_tied_urls_and_ips_order_identically(self, pg_engine, pg_session_maker, clean_tables):
        ts = NOW - timedelta(days=2)
        async with pg_session_maker() as session:
            for url, ip in (("/tie-b", "5.5.5.5"), ("/tie-a", "6.6.6.6")):
                for _ in range(2):
                    await _insert_log(
                        session, ts=ts, url=url, user_agent="tie/1.0", ip=ip,
                        country="NO", country_name="Norway", city="Oslo",
                    )
            await session.commit()
        await _refresh_all(pg_engine)
        async with pg_session_maker() as session:
            routed_u = await SummaryStatsRepository(session=session).get_top_urls(B_START, B_END)
            raw_u = await LiveStatsRepository(session=session).get_top_urls(B_START, B_END)
            routed_i = await SummaryStatsRepository(session=session).get_top_ips(B_START, B_END)
            raw_i = await LiveStatsRepository(session=session).get_top_ips(B_START, B_END)
        assert [r.url for r in routed_u] == ["/tie-a", "/tie-b"], "equal hits break ties by url ASC"
        assert routed_u == raw_u
        assert [r.ip_address for r in routed_i] == ["5.5.5.5", "6.6.6.6"], "equal hits break ties by ip ASC"
        assert routed_i == raw_i
