"""Retention settings must not let a CAGG refresh window reach past raw retention."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import MagicMock

import pytest

from geometrikks.server import timescale

pytestmark = pytest.mark.anyio


@pytest.mark.parametrize("days", [1, 2, 3])
def test_refresh_offsets_reject_raw_retention_inside_the_daily_window(days: int) -> None:
    with pytest.raises(ValueError, match="ANALYTICS_RAW_RETENTION_DAYS") as exc:
        timescale.check_refresh_offsets(raw_retention_days=days)
    assert "summary_daily_stats" in str(exc.value)
    assert "at least 4" in str(exc.value)


@pytest.mark.parametrize("days", [4, 60, 180])
def test_refresh_offsets_accept_raw_retention_beyond_every_window(days: int) -> None:
    timescale.check_refresh_offsets(raw_retention_days=days)


async def test_setup_refuses_a_bad_retention_before_touching_the_database() -> None:
    engine = MagicMock()
    analytics = SimpleNamespace(
        raw_retention_days=2,
        debug_retention_days=30,
        hourly_retention_days=60,
        compression_after_days=7,
        cagg_refresh_interval_minutes=5,
    )
    with pytest.raises(ValueError, match="ANALYTICS_RAW_RETENTION_DAYS"):
        await timescale.setup_timescaledb(engine, cast("Any", analytics))
    engine.begin.assert_not_called()
