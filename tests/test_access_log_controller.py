"""Filter construction for the historical access-logs list endpoint."""
from __future__ import annotations

from datetime import datetime, timezone

from advanced_alchemy.extensions.litestar import filters

from geometrikks.api.v1.access_log_controller import build_list_filters


def test_orders_newest_first_by_default() -> None:
    result = build_list_filters(None, None)
    order = next(f for f in result if isinstance(f, filters.OrderBy))
    assert order.field_name == "timestamp"
    assert order.sort_order == "desc"


def test_no_window_when_both_bounds_none() -> None:
    result = build_list_filters(None, None)
    assert not any(isinstance(f, filters.OnBeforeAfter) for f in result)


def test_adds_window_when_bounds_present() -> None:
    start = datetime(2026, 7, 1, tzinfo=timezone.utc)
    end = datetime(2026, 7, 2, tzinfo=timezone.utc)
    window = next(f for f in build_list_filters(start, end) if isinstance(f, filters.OnBeforeAfter))
    assert window.field_name == "timestamp"
    assert window.on_or_after == start
    assert window.on_or_before == end
