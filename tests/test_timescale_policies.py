"""Retention settings must not let a CAGG refresh window reach past raw retention."""
from __future__ import annotations

import re
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


class _PolicyResult:
    def __init__(self, rows: list[tuple[int, str]] | None = None) -> None:
        self._rows = rows or []

    def all(self) -> list[tuple[int, str]]:
        return self._rows


class _PolicyTransactionConn:
    """Model PostgreSQL transaction aborts and savepoint rollback."""

    def __init__(
        self,
        targets: list[str],
        *,
        missing_targets: set[str] | None = None,
        fail_add_target: str | None = None,
        fail_sync_target: str | None = None,
    ) -> None:
        self._job_targets = {index: target for index, target in enumerate(targets, start=1)}
        self._target_jobs = {target: index for index, target in self._job_targets.items()}
        self._existing = set(targets) - (missing_targets or set())
        self._fail_add_target = fail_add_target
        self._fail_sync_target = fail_sync_target
        self.add_attempts: list[str] = []
        self.sync_attempts: list[str] = []
        self._pending_syncs: list[str] = []
        self.committed_targets: set[str] = set()
        self.committed_syncs: list[str] = []
        self.aborted = False
        self.savepoints = 0

    async def execute(self, statement: Any, params: Any = None) -> _PolicyResult:
        if self.aborted:
            raise RuntimeError("current transaction is aborted, commands ignored")

        sql = str(statement)
        if "add_retention_policy" in sql:
            match = re.search(r"add_retention_policy\(\s*'([^']+)'", sql)
            assert match is not None
            target = match.group(1)
            self.add_attempts.append(target)
            if target == self._fail_add_target:
                self.aborted = True
                raise RuntimeError("add policy denied")
            self._existing.add(target)
            return _PolicyResult()

        if "SELECT j.job_id, j.config->>:key AS current" in sql:
            target = params["target"]
            self.sync_attempts.append(target)
            if target not in self._existing:
                return _PolicyResult()
            return _PolicyResult([(self._target_jobs[target], "90 days")])

        if "SELECT alter_job" in sql:
            target = self._job_targets[params["job_id"]]
            if target == self._fail_sync_target:
                self.aborted = True
                raise RuntimeError("sync update denied")
            self._pending_syncs.append(target)
            return _PolicyResult()

        raise AssertionError(f"Unexpected SQL: {sql}")

    def begin_nested(self) -> Any:
        conn = self
        existing = set(self._existing)
        sync_count = len(self._pending_syncs)

        class _Savepoint:
            async def __aenter__(self) -> None:
                conn.savepoints += 1

            async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
                if exc_type is not None:
                    conn._existing = existing
                    del conn._pending_syncs[sync_count:]
                    conn.aborted = False
                return False

        return _Savepoint()

    def commit(self) -> None:
        if self.aborted:
            self._existing.clear()
            self._pending_syncs.clear()
            return
        self.committed_targets = set(self._existing)
        self.committed_syncs = list(self._pending_syncs)


async def test_policy_failures_do_not_abort_later_policy_updates() -> None:
    targets = [
        "geo_events",
        "access_logs",
        "access_log_debug",
        *timescale.HOURLY_CAGGS,
    ]
    conn = _PolicyTransactionConn(targets, fail_sync_target="access_logs")

    await timescale._add_retention_policies(
        cast("Any", conn),
        raw_retention_days=180,
        debug_retention_days=30,
        hourly_retention_days=60,
    )
    conn.commit()

    assert conn.add_attempts == targets
    assert conn.sync_attempts == targets
    assert conn.committed_targets == set(targets)
    assert conn.committed_syncs == [target for target in targets if target != "access_logs"]
    assert conn.savepoints == len(targets)
    assert timescale.get_policy_failures() == [
        timescale.PolicyFailure("retention", "access_logs", "sync update denied")
    ]


async def test_missing_policy_add_failure_is_recorded_and_later_targets_continue() -> None:
    targets = [
        "geo_events",
        "access_logs",
        "access_log_debug",
        *timescale.HOURLY_CAGGS,
    ]
    conn = _PolicyTransactionConn(
        targets,
        missing_targets={"access_logs"},
        fail_add_target="access_logs",
    )

    await timescale._add_retention_policies(
        cast("Any", conn),
        raw_retention_days=180,
        debug_retention_days=30,
        hourly_retention_days=60,
    )
    conn.commit()

    assert conn.add_attempts == targets
    assert conn.sync_attempts == [target for target in targets if target != "access_logs"]
    assert conn.committed_targets == set(targets) - {"access_logs"}
    assert conn.committed_syncs == [target for target in targets if target != "access_logs"]
    assert timescale.get_policy_failures() == [
        timescale.PolicyFailure("retention", "access_logs", "add policy denied")
    ]


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
