"""Ordering, time-window, and filtering for the access-logs list, on real TimescaleDB."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from advanced_alchemy.filters import (
    CollectionFilter,
    FilterGroup,
    LimitOffset,
    NotInCollectionFilter,
    NullFilter,
    OnBeforeAfter,
    OrderBy,
)
from sqlalchemy import or_, text

from geometrikks.domain.logs.services import AccessLogService
from geometrikks.server.timescale import refresh_caggs_range

import pytest

pytestmark = pytest.mark.anyio

# Wall-clock-relative so seeds stay inside the raw-retention window (see conftest).
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def _insert(
    session_maker,
    ts: datetime,
    ip: str,
    *,
    method: str = "GET",
    url: str = "/x",
    host: str | None = "example.com",
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


async def test_host_exact_include_and_exclude(pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.1", host="api.example.com")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.2", host="cdn.other.net")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.3", host="vault.example.com")
    async with pg_session_maker() as session:
        service = AccessLogService(session=session)
        included, included_total = await service.get_many_and_count(
            _window(),
            CollectionFilter("host", ["api.example.com"]),
            LimitOffset(50, 0),
        )
        excluded, excluded_total = await service.get_many_and_count(
            _window(),
            NotInCollectionFilter("host", ["api.example.com"]),
            LimitOffset(50, 0),
        )
    assert included_total == 1
    assert str(included[0].ip_address) == "10.0.0.1"
    assert excluded_total == 2
    assert sorted(str(r.ip_address) for r in excluded) == ["10.0.0.2", "10.0.0.3"]


async def test_host_exclude_keeps_rows_with_no_host(pg_session_maker, clean_tables) -> None:
    # The parser writes NULL when a log line carries no host. A bare NOT IN
    # would evaluate NULL and drop these rows, hiding traffic the user never
    # asked to exclude.
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.1", host="vault.example.com")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.2", host=None)
    async with pg_session_maker() as session:
        service = AccessLogService(session=session)
        results, total = await service.get_many_and_count(
            _window(),
            FilterGroup(
                logical_operator=or_,
                filters=[
                    NotInCollectionFilter("host", ["vault.example.com"]),
                    NullFilter("host"),
                ],
            ),
            LimitOffset(50, 0),
        )
    assert total == 1
    assert str(results[0].ip_address) == "10.0.0.2"


async def test_ip_exclude_removes_matching_rows(pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.1")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.2")
    async with pg_session_maker() as session:
        service = AccessLogService(session=session)
        results, total = await service.get_many_and_count(
            _window(),
            NotInCollectionFilter("ip_address", ["10.0.0.1"]),
            LimitOffset(50, 0),
        )
    assert total == 1
    assert str(results[0].ip_address) == "10.0.0.2"


async def test_ip_include_and_exclude_of_same_value_yields_nothing(
    pg_session_maker, clean_tables
) -> None:
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.1")
    async with pg_session_maker() as session:
        service = AccessLogService(session=session)
        _, total = await service.get_many_and_count(
            _window(),
            CollectionFilter("ip_address", ["10.0.0.1"]),
            NotInCollectionFilter("ip_address", ["10.0.0.1"]),
            LimitOffset(50, 0),
        )
    assert total == 0


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


async def test_get_facets_distinct_sorted_and_null_free(pg_session_maker, pg_engine, clean_tables) -> None:
    ts = NOW - timedelta(hours=1)
    # Two Oslo/NO rows -> must dedupe; one SE row; one row without geo data.
    await _insert(pg_session_maker, ts, "10.0.0.1",
                  country_code="NO", country_name="Norway", city="Oslo")
    await _insert(pg_session_maker, ts, "10.0.0.2",
                  country_code="NO", country_name="Norway", city="Oslo")
    await _insert(pg_session_maker, ts, "10.0.0.3",
                  country_code="SE", country_name="Sweden", city="Stockholm")
    await _insert(pg_session_maker, ts, "10.0.0.4")

    # Facets now read log_ip_daily_stats: refresh the window so stale
    # materialized buckets from earlier tests are wiped (clean_tables only
    # DELETEs raw rows) and the fresh seeds are materialized.
    await refresh_caggs_range(
        pg_engine,
        start=NOW - timedelta(days=1),
        end=NOW + timedelta(hours=1),
        caggs=["log_ip_daily_stats"],
    )

    async with pg_session_maker() as session:
        facets = await AccessLogService(session=session).get_facets()

    assert [(c.code, c.name) for c in facets.countries] == [("NO", "Norway"), ("SE", "Sweden")]
    assert facets.cities == ["Oslo", "Stockholm"]


async def test_get_facets_dedupes_by_code_preferring_non_null_name(pg_session_maker, pg_engine, clean_tables) -> None:
    ts = NOW - timedelta(hours=1)
    # Same code with and without a name -> one entry, named variant wins.
    await _insert(pg_session_maker, ts, "10.0.0.1", country_code="NO")
    await _insert(pg_session_maker, ts, "10.0.0.2", country_code="NO", country_name="Norway")

    # Facets now read log_ip_daily_stats: refresh the window so stale
    # materialized buckets from earlier tests are wiped (clean_tables only
    # DELETEs raw rows) and the fresh seeds are materialized.
    await refresh_caggs_range(
        pg_engine,
        start=NOW - timedelta(days=1),
        end=NOW + timedelta(hours=1),
        caggs=["log_ip_daily_stats"],
    )

    async with pg_session_maker() as session:
        facets = await AccessLogService(session=session).get_facets()

    assert [(c.code, c.name) for c in facets.countries] == [("NO", "Norway")]


async def test_get_facets_falls_back_to_code_when_name_missing(pg_session_maker, pg_engine, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.5", country_code="DE")

    # Facets now read log_ip_daily_stats: refresh the window so stale
    # materialized buckets from earlier tests are wiped (clean_tables only
    # DELETEs raw rows) and the fresh seeds are materialized.
    await refresh_caggs_range(
        pg_engine,
        start=NOW - timedelta(days=1),
        end=NOW + timedelta(hours=1),
        caggs=["log_ip_daily_stats"],
    )

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


async def test_facets_lists_distinct_hosts(pg_engine, pg_session_maker, clean_tables) -> None:
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.1", host="b.example.com")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.2", host="a.example.com")
    await _insert(pg_session_maker, NOW - timedelta(hours=1), "10.0.0.3", host="b.example.com")
    # Hosts now read host_daily_stats: refresh the window so stale materialized
    # buckets from earlier tests are wiped (clean_tables only DELETEs raw rows).
    await refresh_caggs_range(
        pg_engine,
        start=NOW - timedelta(days=1),
        end=NOW + timedelta(hours=1),
        caggs=["host_daily_stats"],
    )
    async with pg_session_maker() as session:
        facets = await AccessLogService(session=session).get_facets()
    # Deduped and alphabetical.
    assert facets.hosts == ["a.example.com", "b.example.com"]
