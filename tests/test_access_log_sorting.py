"""Sorting the access-log list by a nullable timing puts NULLs last both ways."""
from __future__ import annotations

from typing import cast

from advanced_alchemy.filters import FilterTypes, OrderBy
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from geometrikks.domain.logs.models import AccessLog
from geometrikks.domain.logs.sorting import NullsLastOrderBy, nulls_last_for_timings


def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect()))


def test_nulls_last_order_by_desc_and_asc() -> None:
    desc = NullsLastOrderBy("request_time", "desc").append_to_statement(select(AccessLog), AccessLog)
    asc = NullsLastOrderBy("request_time", "asc").append_to_statement(select(AccessLog), AccessLog)
    assert "ORDER BY access_logs.request_time DESC NULLS LAST" in _sql(desc)
    assert "ORDER BY access_logs.request_time ASC NULLS LAST" in _sql(asc)


def test_only_timing_sorts_are_rewritten() -> None:
    filters = cast(list[FilterTypes], [OrderBy("request_time", "desc"), OrderBy("timestamp", "desc")])
    rewritten = nulls_last_for_timings(filters)
    assert isinstance(rewritten[0], NullsLastOrderBy)
    assert rewritten[0].field_name == "request_time" and rewritten[0].sort_order == "desc"
    assert rewritten[1] is filters[1]
