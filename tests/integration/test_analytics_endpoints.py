"""Repo-level tests for the analytics top-lists (and later time-series) endpoints.

Tests go through the repositories rather than HTTP so they stay independent
of auth wiring.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from geometrikks.domain.analytics.repositories import LiveStatsRepository

# Wall-clock derived, hour-aligned (see test_repositories_pg.py for why).
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def _insert_log(session, *, ts, url, user_agent, status=200, bytes_sent=100, rt=0.01):
    # access_logs is an id-only base: no created_at/updated_at columns.
    await session.execute(text(
        "INSERT INTO access_logs (timestamp, ip_address, method, url, "
        "status_code, bytes_sent, request_time, user_agent) "
        "VALUES (:ts, '10.0.0.1', 'GET', :url, :status, :bytes, :rt, :ua)"
    ), {"ts": ts, "url": url, "status": status, "bytes": bytes_sent, "rt": rt, "ua": user_agent})


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
