"""Pre-host URL CAGGs are rebuilt with a host dimension on startup.

Log events are read off a MagicMock swapped in for ``timescale.logger``,
the same way the unit tests in test_timescale_cagg_columns.py do it.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from geometrikks.config.settings import get_settings
from geometrikks.domain.analytics.repositories import SummaryStatsRepository
from geometrikks.server import timescale
from geometrikks.server.timescale import (
    URL_CAGGS,
    _cagg_columns_need_upgrade,
    _url_caggs_need_upgrade,
    setup_timescaledb,
)
from tests.integration.test_top_caggs_pg import B_END, B_START, NOW, _insert_log

pytestmark = pytest.mark.anyio

BUSY_HOUR = (NOW - timedelta(days=2)).replace(minute=0, second=0, microsecond=0)

# The shape PR #180 left behind: latency columns present, no host.
PRE_HOST_URL = """
    CREATE MATERIALIZED VIEW {name}
    WITH (timescaledb.continuous) AS
    SELECT
        time_bucket('{bucket}', timestamp) AS bucket,
        url,
        COUNT(*) AS hits,
        COUNT(*) FILTER (WHERE status_code >= 400) AS error_hits,
        COUNT(request_time) AS timed_hits,
        COALESCE(SUM(bytes_sent), 0) AS total_bytes,
        SUM(request_time) AS total_request_time,
        COUNT(request_time) FILTER (WHERE status_code NOT IN (0, 101)) AS latency_hits,
        SUM(request_time) FILTER (WHERE status_code NOT IN (0, 101)) AS total_latency
    FROM access_logs
    WHERE url IS NOT NULL
    GROUP BY bucket, url
    WITH NO DATA
"""
# Two releases behind: neither host nor the latency columns.
PRE_LATENCY_URL = """
    CREATE MATERIALIZED VIEW {name}
    WITH (timescaledb.continuous) AS
    SELECT
        time_bucket('{bucket}', timestamp) AS bucket,
        url,
        COUNT(*) AS hits,
        COUNT(*) FILTER (WHERE status_code >= 400) AS error_hits,
        COUNT(request_time) AS timed_hits,
        COALESCE(SUM(bytes_sent), 0) AS total_bytes,
        SUM(request_time) AS total_request_time
    FROM access_logs
    WHERE url IS NOT NULL
    GROUP BY bucket, url
    WITH NO DATA
"""
BUCKETS = {"url_hourly_stats": "1 hour", "url_daily_stats": "1 day"}


async def _drop_with_retry(engine, *caggs: str, attempts: int = 4) -> None:
    """DROP CASCADE can race a background refresh job ("tuple concurrently
    deleted"); retry, one transaction per attempt because a failure aborts
    the one it ran in."""
    for cagg in caggs:
        for attempt in range(attempts):
            try:
                async with engine.begin() as conn:
                    await conn.execute(text(f"DROP MATERIALIZED VIEW IF EXISTS {cagg} CASCADE"))
                break
            except DBAPIError:
                if attempt == attempts - 1:
                    raise


async def _install(pg_engine, shapes: dict[str, str]) -> None:
    await _drop_with_retry(pg_engine, *shapes)
    async with pg_engine.begin() as conn:
        for view, shape in shapes.items():
            await conn.execute(text(shape.format(name=view, bucket=BUCKETS[view])))


async def _columns(pg_engine, view: str) -> set[str]:
    async with pg_engine.connect() as conn:
        rows = await conn.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name = :view"
        ), {"view": view})
        return {r.column_name for r in rows}


async def _seed(pg_session_maker) -> None:
    async with pg_session_maker() as session:
        for host, count in (("app-a.example.com", 3), ("app-b.example.com", 2)):
            for _ in range(count):
                await _insert_log(session, ts=BUSY_HOUR + timedelta(minutes=5), url="/graphql", host=host, rt=0.5)
        await _insert_log(session, ts=BUSY_HOUR + timedelta(minutes=5), url="/ws", host="app-a.example.com", status=101, rt=9000.0)
        await session.commit()


def _events(logger_method: Any) -> list[tuple[str, dict]]:
    return [(call.args[0], call.kwargs) for call in logger_method.call_args_list if call.args]


async def _setup_with_logger(pg_engine, monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    logger = MagicMock()
    monkeypatch.setattr(timescale, "logger", logger)
    await setup_timescaledb(pg_engine, get_settings().analytics)
    return logger


async def test_setup_rebuilds_pre_host_views_and_fills_them(pg_engine, pg_session_maker, clean_tables, monkeypatch):
    await _seed(pg_session_maker)
    await _install(pg_engine, {v: PRE_HOST_URL for v in URL_CAGGS})
    assert "host" not in await _columns(pg_engine, "url_hourly_stats")
    async with pg_engine.connect() as conn:
        assert await _url_caggs_need_upgrade(conn) is True

    logger = await _setup_with_logger(pg_engine, monkeypatch)

    assert [kw["views"] for ev, kw in _events(logger.warning) if ev == "url_caggs_recreated"] == [URL_CAGGS]
    for view in URL_CAGGS:
        assert {"host", "latency_hits", "total_latency"} <= await _columns(pg_engine, view)
    async with pg_engine.connect() as conn:
        rows = (await conn.execute(text("""
            SELECT host, hits, latency_hits FROM url_hourly_stats
            WHERE bucket = :b AND url = '/graphql' ORDER BY host
        """), {"b": BUSY_HOUR})).all()
        assert [(r.host, r.hits, r.latency_hits) for r in rows] == [
            ("app-a.example.com", 3, 3), ("app-b.example.com", 2, 2),
        ], "the refresh after the rebuild fills every column, host and latency alike"
        assert await _url_caggs_need_upgrade(conn) is False
        raw_days = get_settings().analytics.raw_retention_days
        assert await _cagg_columns_need_upgrade(conn, raw_retention_days=raw_days) == []
    async with pg_session_maker() as session:
        routed = await SummaryStatsRepository(session=session).get_top_urls(B_START, B_END)
    assert [(r.host, r.url, r.hits, r.timed_hits) for r in routed] == [
        ("app-a.example.com", "/graphql", 3, 3),
        ("app-b.example.com", "/graphql", 2, 2),
        ("app-a.example.com", "/ws", 1, 0),
    ]


async def test_two_releases_behind_is_one_rebuild_not_an_alter(pg_engine, pg_session_maker, clean_tables, monkeypatch):
    """A view lacking both host and the latency columns is dropped once; the
    column upgrade must not try to ALTER a view that no longer exists."""
    await _seed(pg_session_maker)
    await _install(pg_engine, {v: PRE_LATENCY_URL for v in URL_CAGGS})

    logger = await _setup_with_logger(pg_engine, monkeypatch)

    assert [ev for ev, _ in _events(logger.warning) if ev == "url_caggs_recreated"] == ["url_caggs_recreated"]
    added = [kw for ev, kw in _events(logger.info) if ev == "cagg_column_added" and kw["view"] in URL_CAGGS]
    assert added == [], "the URL pair is rebuilt, never ALTERed"
    for view in URL_CAGGS:
        assert {"host", "latency_hits", "total_latency"} <= await _columns(pg_engine, view)


async def test_rerun_is_a_no_op(pg_engine, clean_tables, monkeypatch):
    logger = await _setup_with_logger(pg_engine, monkeypatch)
    assert "url_caggs_recreated" not in [ev for ev, _ in _events(logger.warning)]
    async with pg_engine.connect() as conn:
        assert await _url_caggs_need_upgrade(conn) is False
