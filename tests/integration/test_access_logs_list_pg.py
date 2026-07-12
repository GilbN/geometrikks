"""Ordering + time-window filtering for the access-logs list, on real TimescaleDB."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from advanced_alchemy.extensions.litestar import filters
from sqlalchemy import text

from geometrikks.api.v1.access_log_controller import build_list_filters
from geometrikks.domain.logs.repositories import AccessLogRepository

# Wall-clock-relative so seeds stay inside the raw-retention window (see conftest).
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def _insert(session_maker, ts: datetime, ip: str) -> None:
    async with session_maker() as session:
        await session.execute(
            text(
                "INSERT INTO access_logs (timestamp, ip_address, method, url, "
                " status_code, bytes_sent, request_time) "
                "VALUES (:ts, :ip, 'GET', '/x', 200, 100, 0.01)"
            ),
            {"ts": ts, "ip": ip},
        )
        await session.commit()


async def test_list_orders_newest_first(pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(hours=2), "10.0.0.1")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.2")
    async with pg_session_maker() as session:
        repo = AccessLogRepository(session=session)
        results, total = await repo.get_many_and_count(
            *build_list_filters(None, None), filters.LimitOffset(50, 0)
        )
    assert total == 2
    assert [str(r.ip_address) for r in results] == ["10.0.0.2", "10.0.0.1"]


async def test_list_window_excludes_rows_outside_range(pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(days=2), "10.0.0.9")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.2")
    async with pg_session_maker() as session:
        repo = AccessLogRepository(session=session)
        results, total = await repo.get_many_and_count(
            *build_list_filters(NOW - timedelta(hours=3), NOW), filters.LimitOffset(50, 0)
        )
    assert total == 1
    assert str(results[0].ip_address) == "10.0.0.2"
