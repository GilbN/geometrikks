"""Retention settings must not let a CAGG refresh window reach past raw retention."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock

import pytest

from geometrikks.server import timescale

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def isolate_policy_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(timescale, "_policy_failures", [], raising=False)


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


def test_policy_failures_are_recorded_and_reset() -> None:
    timescale._reset_policy_failures()
    timescale._record_policy_failure("retention", "geo_events", "permission denied")

    [failure] = timescale.get_policy_failures()
    assert (failure.policy, failure.target, failure.error) == (
        "retention",
        "geo_events",
        "permission denied",
    )

    timescale._reset_policy_failures()
    assert timescale.get_policy_failures() == []


async def test_refresh_policy_update_failures_are_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = MagicMock()
    conn.execute = AsyncMock()
    monkeypatch.setattr(
        timescale,
        "_sync_policy_schedule",
        AsyncMock(side_effect=RuntimeError("refresh update denied")),
    )

    await timescale._add_refresh_policies(cast("Any", conn), 5)

    failures = timescale.get_policy_failures()
    assert [(failure.policy, failure.target, failure.error) for failure in failures] == [
        ("refresh", cagg, "refresh update denied")
        for cagg, _start_offset, _end_offset in timescale.CAGG_REFRESH_CONFIG
    ]


async def test_retention_policy_update_failures_are_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = MagicMock()
    conn.execute = AsyncMock()
    monkeypatch.setattr(
        timescale,
        "_sync_policy_config",
        AsyncMock(side_effect=RuntimeError("retention update denied")),
    )

    await timescale._add_retention_policies(
        cast("Any", conn),
        raw_retention_days=180,
        debug_retention_days=30,
        hourly_retention_days=60,
    )

    expected_targets = [
        "geo_events",
        "access_logs",
        "access_log_debug",
        *timescale.HOURLY_CAGGS,
    ]
    failures = timescale.get_policy_failures()
    assert [(failure.policy, failure.target, failure.error) for failure in failures] == [
        ("retention", target, "retention update denied") for target in expected_targets
    ]


async def test_compression_policy_update_failures_are_recorded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = MagicMock()
    conn.execute = AsyncMock()
    monkeypatch.setattr(
        timescale,
        "_sync_policy_config",
        AsyncMock(side_effect=RuntimeError("compression update denied")),
    )

    await timescale._add_compression_policies(cast("Any", conn), 7)

    failures = timescale.get_policy_failures()
    assert [(failure.policy, failure.target, failure.error) for failure in failures] == [
        ("compression", table, "compression update denied")
        for table in ("geo_events", "access_logs", "access_log_debug")
    ]


async def test_successful_setup_resets_previous_policy_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    timescale._record_policy_failure("retention", "geo_events", "old failure")
    conn = MagicMock()
    begin_context = MagicMock()
    begin_context.__aenter__ = AsyncMock(return_value=conn)
    begin_context.__aexit__ = AsyncMock(return_value=False)
    engine = MagicMock()
    engine.begin.return_value = begin_context

    for name in (
        "_enable_extensions",
        "_create_hypertables",
        "_create_summary_caggs",
        "_create_geo_summary_caggs",
        "_create_location_caggs",
        "_create_ip_location_cagg",
        "_create_log_ip_caggs",
        "_create_url_caggs",
        "_create_user_agent_caggs",
        "_create_asn_caggs",
        "_create_host_facet_caggs",
        "_enable_realtime_aggregation",
        "_add_refresh_policies",
        "_add_retention_policies",
        "_add_compression_policies",
        "backfill_cagg_gaps",
    ):
        monkeypatch.setattr(timescale, name, AsyncMock(return_value=None))
    monkeypatch.setattr(
        timescale, "_summary_caggs_need_upgrade", AsyncMock(return_value=False)
    )
    monkeypatch.setattr(
        timescale, "_url_caggs_need_upgrade", AsyncMock(return_value=False)
    )
    monkeypatch.setattr(
        timescale, "_cagg_columns_need_upgrade", AsyncMock(return_value=[])
    )
    monkeypatch.setattr(
        timescale, "_location_caggs_need_upgrade", AsyncMock(return_value=False)
    )
    monkeypatch.setattr(
        timescale,
        "detect_hostname_pollution",
        AsyncMock(return_value=timescale.classify_hostnames([])),
    )
    analytics = SimpleNamespace(
        raw_retention_days=180,
        debug_retention_days=30,
        hourly_retention_days=60,
        compression_after_days=7,
        cagg_refresh_interval_minutes=5,
    )

    await timescale.setup_timescaledb(engine, cast("Any", analytics))

    assert timescale.get_policy_failures() == []
