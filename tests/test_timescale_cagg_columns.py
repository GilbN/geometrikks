"""In-place column upgrades for the summary and URL CAGGs."""
from __future__ import annotations

from typing import Any, cast

import pytest

from geometrikks.server import timescale

pytestmark = pytest.mark.anyio


class _Scalar:
    """Minimal stand-in for a Result whose only use is .scalar()."""

    def __init__(self, value: Any = None) -> None:
        self._value = value

    def scalar(self) -> Any:
        return self._value


class RecordingConn:
    """AsyncConnection double that records every statement."""

    def __init__(self) -> None:
        self.statements: list[str] = []

    async def execute(self, statement: Any, params: Any = None) -> Any:
        self.statements.append(str(statement))
        return _Scalar(None)


def test_latency_filter_renders_the_exclusion_tuple() -> None:
    assert timescale.LATENCY_STATUS_EXCLUSIONS == (0, 101)
    assert timescale.LATENCY_FILTER == "status_code NOT IN (0, 101)"
    assert timescale.latency_filter("al.") == "al.status_code NOT IN (0, 101)"


def test_cagg_column_ddl() -> None:
    column = timescale.CaggColumn("max_latency", "double precision", "MAX(request_time)")
    assert column.ddl == "max_latency double precision GENERATED ALWAYS AS (MAX(request_time)) STORED"


def test_column_table_covers_every_upgraded_view() -> None:
    assert set(timescale.CAGG_COLUMNS) == {
        "summary_hourly_stats", "summary_daily_stats", "url_hourly_stats", "url_daily_stats",
    }
    assert set(timescale.CAGG_PROBE_COLUMNS) == set(timescale.CAGG_COLUMNS)
    for view, columns in timescale.CAGG_COLUMNS.items():
        names = [c.name for c in columns]
        assert timescale.CAGG_PROBE_COLUMNS[view] in names
        assert timescale.CAGG_PROBE_COLUMNS[view].startswith("latency_")
    assert [c.name for c in timescale.CAGG_COLUMNS["summary_hourly_stats"]] == [
        "timed_requests", "latency_requests", "avg_latency", "max_latency", "latency_pct_agg",
    ]
    assert [c.name for c in timescale.CAGG_COLUMNS["url_daily_stats"]] == [
        "timed_hits", "latency_hits", "total_latency",
    ]


async def test_create_statements_define_every_upgrade_column() -> None:
    """Fresh installs get the columns from CREATE with the same expression
    the in-place upgrade uses, so both shapes stay identical."""
    conn = RecordingConn()
    await timescale._create_summary_caggs(cast("Any", conn))
    await timescale._create_url_caggs(cast("Any", conn))
    creates = [s for s in conn.statements if "CREATE MATERIALIZED VIEW" in s]
    for view, columns in timescale.CAGG_COLUMNS.items():
        create = next(s for s in creates if f"IF NOT EXISTS {view}\n" in s or f"IF NOT EXISTS {view} " in s)
        for column in columns:
            assert f"{column.expression} AS {column.name}" in create, (view, column.name)
