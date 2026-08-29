"""IpProfileRepository against real TimescaleDB."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from geometrikks.domain.analytics.ip_profile import IpProfileRepository

pytestmark = pytest.mark.anyio

# Wall-clock derived and hour-aligned; see test_repositories_pg.py.
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
IP = "203.0.113.7"
OTHER_IP = "198.51.100.9"


async def _insert_log(
    session, *, ts, ip=IP, url="/", host="blog.example.com", status=200,
    bytes_sent=100, rt=0.01, ua="Go-http-client/1.1", asn=None, org=None,
):
    await session.execute(text(
        "INSERT INTO access_logs (timestamp, ip_address, method, url, host, status_code, "
        "bytes_sent, request_time, user_agent, autonomous_system_number, "
        "autonomous_system_organization) "
        "VALUES (:ts, CAST(:ip AS inet), 'GET', :url, :host, :status, :bytes, :rt, :ua, "
        ":asn, :org)"
    ), {
        "ts": ts, "ip": ip, "url": url, "host": host, "status": status,
        "bytes": bytes_sent, "rt": rt, "ua": ua, "asn": asn, "org": org,
    })


async def _insert_malformed(session, *, ts, ip=IP):
    await session.execute(text(
        "INSERT INTO access_log_debug (created_at, raw_line, is_malformed, ip_address) "
        "VALUES (:ts, 'garbage', true, CAST(:ip AS inet))"
    ), {"ts": ts, "ip": ip})


async def test_profile_totals_lists_and_isolation(pg_session_maker, clean_tables):
    t0 = NOW - timedelta(hours=3)
    t1 = NOW - timedelta(hours=2)
    async with pg_session_maker() as session:
        for _ in range(4):
            await _insert_log(session, ts=t0, url="/wp-login.php", status=403, asn=64500, org="Old Org")
        await _insert_log(session, ts=t1, url="/.env", status=404, host="cloud.example.com",
                          ua="curl/8.0", asn=64501, org="New Org", bytes_sent=50)
        await _insert_log(session, ts=t1, url="/", status=200, rt=0.5)
        await _insert_log(session, ts=t1, ip=OTHER_IP, url="/leak", status=500)
        await _insert_malformed(session, ts=t1)
        await _insert_malformed(session, ts=t1, ip=OTHER_IP)
        await session.commit()

    async with pg_session_maker() as session:
        profile = await IpProfileRepository(session).get_profile(
            IP, NOW - timedelta(hours=6), NOW
        )

    assert profile.total_requests == 6
    assert (profile.status_2xx, profile.status_4xx, profile.status_5xx) == (1, 5, 0)
    assert profile.total_bytes == 4 * 100 + 50 + 100
    assert profile.first_seen == t0 and profile.last_seen == t1
    assert profile.distinct_paths == 3
    assert profile.malformed_requests == 1
    # Newest row's ASN wins, not the most frequent one.
    assert (profile.asn, profile.asn_organization) == (64501, "New Org")
    assert [(h.host, h.hits, h.error_hits) for h in profile.hosts] == [
        ("blog.example.com", 5, 4), ("cloud.example.com", 1, 1),
    ]
    assert [(p.host, p.url) for p in profile.paths] == [
        ("blog.example.com", "/wp-login.php"), ("blog.example.com", "/"), ("cloud.example.com", "/.env"),
    ]
    assert [(u.user_agent, u.hits) for u in profile.user_agents] == [
        ("Go-http-client/1.1", 5), ("curl/8.0", 1),
    ]
    assert profile.granularity == "hourly"
    assert [(b.timestamp, b.hits, b.error_hits) for b in profile.series] == [
        (t0, 4, 4), (t1, 2, 1),
    ]
    assert profile.peak is not None and profile.peak.timestamp == t0


async def test_profile_daily_buckets_above_seven_days(pg_session_maker, clean_tables):
    day_start = NOW.replace(hour=0)
    async with pg_session_maker() as session:
        await _insert_log(session, ts=day_start + timedelta(hours=1))
        await _insert_log(session, ts=day_start + timedelta(hours=5))
        await _insert_log(session, ts=day_start - timedelta(days=3))
        await session.commit()

    async with pg_session_maker() as session:
        profile = await IpProfileRepository(session).get_profile(
            IP, NOW - timedelta(days=10), NOW + timedelta(days=1)
        )

    assert profile.granularity == "daily"
    assert [(b.timestamp, b.hits) for b in profile.series] == [
        (day_start - timedelta(days=3), 1), (day_start, 2),
    ]


async def test_profile_for_unknown_ip_is_empty_but_counts_malformed(pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        await _insert_malformed(session, ts=NOW - timedelta(hours=1))
        await session.commit()

    async with pg_session_maker() as session:
        profile = await IpProfileRepository(session).get_profile(
            IP, NOW - timedelta(hours=6), NOW
        )

    assert profile.total_requests == 0
    assert profile.malformed_requests == 1
    assert profile.first_seen is None and profile.peak is None
    assert profile.hosts == [] and profile.paths == [] and profile.user_agents == []


async def test_profile_hosts_null_host_sorts_last(pg_session_maker, clean_tables):
    t0 = NOW - timedelta(hours=1)
    async with pg_session_maker() as session:
        await _insert_log(session, ts=t0, host="blog.example.com")
        await _insert_log(session, ts=t0, host="blog.example.com")
        await _insert_log(session, ts=t0, host=None)
        await _insert_log(session, ts=t0, host="cloud.example.com")
        await session.commit()

    async with pg_session_maker() as session:
        profile = await IpProfileRepository(session).get_profile(
            IP, NOW - timedelta(hours=6), NOW
        )

    # blog.example.com leads on hits; cloud.example.com and the null host
    # tie at one hit each, and NULLS LAST puts the null host after it.
    assert [(h.host, h.hits) for h in profile.hosts] == [
        ("blog.example.com", 2), ("cloud.example.com", 1), (None, 1),
    ]


async def test_profile_daily_buckets_follow_the_requested_timezone(pg_session_maker, clean_tables):
    # 23:00 UTC on the 20th is already the 21st in Oslo (UTC+2 in August).
    late = datetime(2026, 8, 20, 23, 0, tzinfo=timezone.utc)
    async with pg_session_maker() as session:
        await _insert_log(session, ts=late)
        await session.commit()

    start, end = datetime(2026, 8, 10, tzinfo=timezone.utc), datetime(2026, 8, 25, tzinfo=timezone.utc)
    async with pg_session_maker() as session:
        utc_days = await IpProfileRepository(session).get_profile(IP, start, end)
        oslo_days = await IpProfileRepository(session).get_profile(IP, start, end, tz="Europe/Oslo")

    assert [b.timestamp for b in utc_days.series] == [datetime(2026, 8, 20, tzinfo=timezone.utc)]
    # Oslo's 21st starts at 22:00 UTC on the 20th.
    assert [b.timestamp for b in oslo_days.series] == [datetime(2026, 8, 20, 22, tzinfo=timezone.utc)]
