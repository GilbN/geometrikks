"""Ordering, time-window, and filtering for the access-logs list, on real TimescaleDB."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from advanced_alchemy.filters import (
    CollectionFilter,
    LimitOffset,
    OnBeforeAfter,
    OrderBy,
    SearchFilter,
)
from sqlalchemy import text

from geometrikks.domain.logs.services import AccessLogService

# Wall-clock-relative so seeds stay inside the raw-retention window (see conftest).
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def _insert(
    session_maker,
    ts: datetime,
    ip: str,
    *,
    method: str = "GET",
    url: str = "/x",
    host: str = "example.com",
    status: int = 200,
    country_code: str | None = None,
    country_name: str | None = None,
    city: str | None = None,
) -> None:
    async with session_maker() as session:
        await session.execute(
            text(
                "INSERT INTO access_logs (timestamp, ip_address, method, url, host, "
                " status_code, bytes_sent, request_time, country_code, country_name, city) "
                "VALUES (:ts, :ip, :method, :url, :host, :status, 100, 0.01, "
                " :country_code, :country_name, :city)"
            ),
            {
                "ts": ts, "ip": ip, "method": method, "url": url, "host": host,
                "status": status, "country_code": country_code,
                "country_name": country_name, "city": city,
            },
        )
        await session.commit()


def _window() -> OnBeforeAfter:
    return OnBeforeAfter("timestamp", on_or_after=NOW - timedelta(hours=6), on_or_before=NOW)


async def test_list_orders_newest_first(pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(hours=2), "10.0.0.1")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.2")
    async with pg_session_maker() as session:
        service = AccessLogService(session=session)
        results, total = await service.get_many_and_count(
            OrderBy("timestamp", "desc"), LimitOffset(50, 0)
        )
    assert total == 2
    assert [str(r.ip_address) for r in results] == ["10.0.0.2", "10.0.0.1"]


async def test_list_window_excludes_rows_outside_range(pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(days=2), "10.0.0.9")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.2")
    async with pg_session_maker() as session:
        service = AccessLogService(session=session)
        results, total = await service.get_many_and_count(
            OnBeforeAfter("timestamp", on_or_after=NOW - timedelta(hours=3), on_or_before=NOW),
            LimitOffset(50, 0),
        )
    assert total == 1
    assert str(results[0].ip_address) == "10.0.0.2"


async def test_method_and_ip_in_filters(pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.1", method="GET")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.2", method="POST")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.3", method="DELETE")
    async with pg_session_maker() as session:
        service = AccessLogService(session=session)
        results, total = await service.get_many_and_count(
            _window(),
            CollectionFilter("method", ["GET", "POST"]),
            CollectionFilter("ip_address", ["10.0.0.2"]),
            LimitOffset(50, 0),
        )
    assert total == 1
    assert str(results[0].ip_address) == "10.0.0.2"


async def test_host_substring_search(pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.1", host="api.example.com")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.2", host="cdn.other.net")
    async with pg_session_maker() as session:
        service = AccessLogService(session=session)
        results, total = await service.get_many_and_count(
            _window(),
            SearchFilter("host", "example", ignore_case=True),
            LimitOffset(50, 0),
        )
    assert total == 1
    assert str(results[0].ip_address) == "10.0.0.1"


async def test_sort_by_status_ascending(pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.1", status=500)
    await _insert(pg_session_maker, NOW - timedelta(hours=2), "10.0.0.2", status=200)
    await _insert(pg_session_maker, NOW - timedelta(hours=3), "10.0.0.3", status=404)
    async with pg_session_maker() as session:
        service = AccessLogService(session=session)
        results, _ = await service.get_many_and_count(
            _window(), OrderBy("status_code", "asc"), LimitOffset(50, 0)
        )
    assert [r.status_code for r in results] == [200, 404, 500]


async def test_get_facets_distinct_sorted_and_null_free(pg_session_maker, clean_tables) -> None:
    ts = NOW - timedelta(hours=1)
    # Two Oslo/NO rows -> must dedupe; one SE row; one row without geo data.
    await _insert(pg_session_maker, ts, "10.0.0.1",
                  country_code="NO", country_name="Norway", city="Oslo")
    await _insert(pg_session_maker, ts, "10.0.0.2",
                  country_code="NO", country_name="Norway", city="Oslo")
    await _insert(pg_session_maker, ts, "10.0.0.3",
                  country_code="SE", country_name="Sweden", city="Stockholm")
    await _insert(pg_session_maker, ts, "10.0.0.4")

    async with pg_session_maker() as session:
        facets = await AccessLogService(session=session).get_facets()

    assert [(c.code, c.name) for c in facets.countries] == [("NO", "Norway"), ("SE", "Sweden")]
    assert facets.cities == ["Oslo", "Stockholm"]


async def test_get_facets_falls_back_to_code_when_name_missing(pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.5", country_code="DE")

    async with pg_session_maker() as session:
        facets = await AccessLogService(session=session).get_facets()

    assert [(c.code, c.name) for c in facets.countries] == [("DE", "DE")]
    assert facets.cities == []


async def test_country_and_city_collection_filters_narrow_results(pg_session_maker, clean_tables) -> None:
    ts = NOW - timedelta(hours=1)
    await _insert(pg_session_maker, ts, "10.0.0.1",
                  country_code="NO", country_name="Norway", city="Oslo")
    await _insert(pg_session_maker, ts, "10.0.0.2",
                  country_code="SE", country_name="Sweden", city="Stockholm")

    async with pg_session_maker() as session:
        service = AccessLogService(session=session)
        by_country, total_country = await service.get_many_and_count(
            _window(), CollectionFilter("country_code", ["NO"]), LimitOffset(50, 0)
        )
        by_city, total_city = await service.get_many_and_count(
            _window(), CollectionFilter("city", ["Stockholm"]), LimitOffset(50, 0)
        )

    assert total_country == 1 and str(by_country[0].ip_address) == "10.0.0.1"
    assert total_city == 1 and str(by_city[0].ip_address) == "10.0.0.2"
