"""List + filtering for access_log_debug, on real TimescaleDB.

Context columns (ip/geo/status/etc) are denormalized onto access_log_debug at
ingestion, so these tests seed them directly rather than creating access_logs
rows to join against.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from advanced_alchemy.filters import LimitOffset, OnBeforeAfter, SearchFilter
from litestar.exceptions import ValidationException
from sqlalchemy import text

from geometrikks.domain.logs.services import AccessLogDebugService

pytestmark = pytest.mark.anyio

# Wall-clock-relative so seeds stay inside the retention window.
NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def _insert_debug(
    session_maker,
    created: datetime,
    raw_line: str,
    *,
    access_log_id: int | None = None,
    malformed: bool = False,
    parse_error: str | None = None,
    log_timestamp: datetime | None = None,
    ip: str | None = None,
    method: str | None = None,
    url: str | None = None,
    host: str | None = None,
    status: int | None = None,
    country_code: str | None = None,
    country_name: str | None = None,
    city: str | None = None,
    user_agent: str | None = None,
) -> None:
    """Insert an access_log_debug row, including its denormalized context."""
    async with session_maker() as session:
        await session.execute(
            text(
                "INSERT INTO access_log_debug (created_at, raw_line, access_log_id, "
                " is_malformed, parse_error, log_timestamp, ip_address, method, url, "
                " host, status_code, country_code, country_name, city, user_agent) "
                "VALUES (:created, :raw, :log_id, :malformed, :parse_error, "
                " :log_timestamp, :ip, :method, :url, :host, :status, "
                " :country_code, :country_name, :city, :user_agent)"
            ),
            {
                "created": created, "raw": raw_line, "log_id": access_log_id,
                "malformed": malformed, "parse_error": parse_error,
                "log_timestamp": log_timestamp, "ip": ip, "method": method,
                "url": url, "host": host, "status": status,
                "country_code": country_code, "country_name": country_name,
                "city": city, "user_agent": user_agent,
            },
        )
        await session.commit()


def _window() -> OnBeforeAfter:
    return OnBeforeAfter(
        field_name="created_at",
        on_or_after=NOW - timedelta(hours=6),
        on_or_before=NOW,
    )


async def test_list_returns_denormalized_context_and_nulls_when_unlinked(
    pg_session_maker, clean_tables
) -> None:
    """Linked rows expose their context columns; unlinked rows return None."""
    ts = NOW - timedelta(hours=1)
    log_id = 4242
    await _insert_debug(
        pg_session_maker, ts, "linked line", access_log_id=log_id,
        log_timestamp=ts, ip="10.0.0.1", status=404, country_code="NO",
        country_name="Norway", city="Oslo", user_agent="curl/8",
    )
    await _insert_debug(
        pg_session_maker, ts, "\\x16\\x03 garbage",
        malformed=True, parse_error="regex mismatch",
    )

    async with pg_session_maker() as session:
        service = AccessLogDebugService(session=session)
        rows, total = await service.list_entries(_window(), LimitOffset(50, 0))

    assert total == 2
    by_line = {r.raw_line: r for r in rows}
    linked = by_line["linked line"]
    assert linked.access_log_id == log_id
    assert linked.ip_address == "10.0.0.1"
    assert linked.status_code == 404
    assert linked.country_code == "NO"
    assert linked.country_name == "Norway"
    assert linked.city == "Oslo"
    assert linked.user_agent == "curl/8"
    assert linked.timestamp is not None
    unlinked = by_line["\\x16\\x03 garbage"]
    assert unlinked.access_log_id is None
    assert unlinked.ip_address is None
    assert unlinked.status_code is None
    assert unlinked.is_malformed is True
    assert unlinked.parse_error == "regex mismatch"


async def test_time_window_on_created_at_excludes_rows(pg_session_maker, clean_tables) -> None:
    await _insert_debug(pg_session_maker, NOW - timedelta(days=2), "old line")
    await _insert_debug(pg_session_maker, NOW - timedelta(hours=1), "recent line")

    async with pg_session_maker() as session:
        service = AccessLogDebugService(session=session)
        rows, total = await service.list_entries(_window(), LimitOffset(50, 0))

    assert total == 1
    assert rows[0].raw_line == "recent line"


async def test_search_matches_raw_line_and_parse_error(pg_session_maker, clean_tables) -> None:
    ts = NOW - timedelta(hours=1)
    await _insert_debug(pg_session_maker, ts, "GET /needle-in-line HTTP/1.1")
    await _insert_debug(
        pg_session_maker, ts, "junk", malformed=True, parse_error="NEEDLE in error",
    )
    await _insert_debug(pg_session_maker, ts, "unrelated")

    async with pg_session_maker() as session:
        service = AccessLogDebugService(session=session)
        rows, total = await service.list_entries(
            _window(),
            SearchFilter({"raw_line", "parse_error"}, "needle", ignore_case=True),
            LimitOffset(50, 0),
        )

    assert total == 2
    assert {r.raw_line for r in rows} == {"GET /needle-in-line HTTP/1.1", "junk"}


async def test_malformed_tri_state_filter(pg_session_maker, clean_tables) -> None:
    ts = NOW - timedelta(hours=1)
    await _insert_debug(pg_session_maker, ts, "good line", malformed=False)
    await _insert_debug(pg_session_maker, ts, "bad line", malformed=True)

    async with pg_session_maker() as session:
        service = AccessLogDebugService(session=session)
        all_rows, all_total = await service.list_entries(_window(), LimitOffset(50, 0))
        bad_rows, bad_total = await service.list_entries(
            _window(), LimitOffset(50, 0), malformed=True,
        )
        good_rows, good_total = await service.list_entries(
            _window(), LimitOffset(50, 0), malformed=False,
        )

    assert all_total == 2
    assert bad_total == 1 and bad_rows[0].raw_line == "bad line"
    assert good_total == 1 and good_rows[0].raw_line == "good line"


async def test_context_filters_narrow_and_drop_unlinked(pg_session_maker, clean_tables) -> None:
    """ip/country/city filter on the debug row's own columns.

    Unlinked rows have NULL there, so an IN filter excludes them, which
    preserves the behaviour the old join-based filters had.
    """
    ts = NOW - timedelta(hours=1)
    await _insert_debug(
        pg_session_maker, ts, "norway line", access_log_id=1,
        ip="10.0.0.1", country_code="NO", city="Oslo",
    )
    await _insert_debug(
        pg_session_maker, ts, "sweden line", access_log_id=2,
        ip="10.0.0.2", country_code="SE", city="Stockholm",
    )
    await _insert_debug(pg_session_maker, ts, "unlinked line")

    async with pg_session_maker() as session:
        service = AccessLogDebugService(session=session)
        by_country, country_total = await service.list_entries(
            _window(), LimitOffset(50, 0), country_codes=["NO"],
        )
        by_city, city_total = await service.list_entries(
            _window(), LimitOffset(50, 0), cities=["Stockholm"],
        )
        by_ip, ip_total = await service.list_entries(
            _window(), LimitOffset(50, 0), ip_addresses=["10.0.0.1"],
        )

    assert country_total == 1 and by_country[0].raw_line == "norway line"
    assert city_total == 1 and by_city[0].raw_line == "sweden line"
    assert ip_total == 1 and by_ip[0].raw_line == "norway line"


async def test_sort_by_status_code_puts_nulls_last(pg_session_maker, clean_tables) -> None:
    """status_code sorts on the debug row, with unlinked rows sinking."""
    ts = NOW - timedelta(hours=1)
    await _insert_debug(
        pg_session_maker, ts, "five hundred", access_log_id=1, status=500,
    )
    await _insert_debug(
        pg_session_maker, ts, "two hundred", access_log_id=2, status=200,
    )
    await _insert_debug(pg_session_maker, ts, "no status")

    async with pg_session_maker() as session:
        service = AccessLogDebugService(session=session)
        rows, _ = await service.list_entries(
            _window(), LimitOffset(50, 0), order_by="status_code", sort_order="asc",
        )

    assert [r.status_code for r in rows] == [200, 500, None]
    assert rows[-1].raw_line == "no status"


async def test_default_sort_newest_created_first(pg_session_maker, clean_tables) -> None:
    await _insert_debug(pg_session_maker, NOW - timedelta(hours=2), "older")
    await _insert_debug(pg_session_maker, NOW - timedelta(hours=1), "newer")

    async with pg_session_maker() as session:
        service = AccessLogDebugService(session=session)
        rows, _ = await service.list_entries(_window(), LimitOffset(50, 0))

    assert [r.raw_line for r in rows] == ["newer", "older"]


async def test_pagination_limits_rows_but_counts_all(pg_session_maker, clean_tables) -> None:
    ts = NOW - timedelta(hours=1)
    for i in range(5):
        await _insert_debug(pg_session_maker, ts + timedelta(seconds=i), f"line {i}")

    async with pg_session_maker() as session:
        service = AccessLogDebugService(session=session)
        page1, total = await service.list_entries(_window(), LimitOffset(2, 0))
        page2, _ = await service.list_entries(_window(), LimitOffset(2, 2))

    assert total == 5
    assert len(page1) == 2 and len(page2) == 2
    assert {r.raw_line for r in page1}.isdisjoint({r.raw_line for r in page2})


async def test_unknown_order_by_raises_400(pg_session_maker, clean_tables) -> None:
    async with pg_session_maker() as session:
        service = AccessLogDebugService(session=session)
        with pytest.raises(ValidationException, match="Cannot sort by"):
            await service.list_entries(_window(), LimitOffset(50, 0), order_by="raw_line; DROP TABLE")


async def test_stats_counts_and_top_error(pg_session_maker, clean_tables) -> None:
    ts = NOW - timedelta(hours=1)
    await _insert_debug(pg_session_maker, ts, "ok line")
    await _insert_debug(pg_session_maker, ts, "bad 1", malformed=True, parse_error="regex mismatch")
    await _insert_debug(pg_session_maker, ts, "bad 2", malformed=True, parse_error="regex mismatch")
    await _insert_debug(pg_session_maker, ts, "bad 3", malformed=True, parse_error="bad status")
    # Outside the window: must not count.
    await _insert_debug(pg_session_maker, NOW - timedelta(days=2), "old bad", malformed=True, parse_error="regex mismatch")

    async with pg_session_maker() as session:
        service = AccessLogDebugService(session=session)
        stats = await service.get_stats(
            on_or_after=NOW - timedelta(hours=6), on_or_before=NOW,
        )

    assert stats.total == 4
    assert stats.malformed == 3
    assert stats.top_parse_error is not None
    assert stats.top_parse_error.error == "regex mismatch"
    assert stats.top_parse_error.count == 2


async def test_stats_empty_range_returns_zeros(pg_session_maker, clean_tables) -> None:
    async with pg_session_maker() as session:
        service = AccessLogDebugService(session=session)
        stats = await service.get_stats(
            on_or_after=NOW - timedelta(hours=6), on_or_before=NOW,
        )

    assert stats.total == 0
    assert stats.malformed == 0
    assert stats.top_parse_error is None
