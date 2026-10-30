"""The head's log trail of agent state changes."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID, uuid4

from structlog.testing import capture_logs

from geometrikks.domain.instances.evaluation import (
    HeadIdentity,
    HeartbeatRow,
    InstanceEvaluation,
    evaluate_instances,
)
from geometrikks.domain.instances.monitor import InstanceMonitor

NOW = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)
HEAD_BOOT_ID = uuid4()
HEAD = HeadIdentity(
    boot_id=HEAD_BOOT_ID,
    instance_name="head",
    app_version="0.20.0",
    schema_revision="7c1e9a",
    known_revisions=frozenset({"4b02d1", "7c1e9a"}),
)


def make_row(
    *,
    name: str = "edge-traefik",
    boot_id: UUID | None = None,
    app_version: str = "0.20.0",
    schema_revision: str = "7c1e9a",
    last_seen: datetime = NOW - timedelta(seconds=10),
    payload: dict[str, Any] | None = None,
) -> HeartbeatRow:
    return HeartbeatRow(
        instance_name=name,
        boot_id=boot_id or uuid4(),
        mode="agent",
        app_version=app_version,
        schema_revision=schema_revision,
        started_at=NOW - timedelta(hours=2),
        last_seen=last_seen,
        payload={"instanceNameSource": "env"} if payload is None else payload,
    )


def evaluate(*rows: HeartbeatRow) -> list[InstanceEvaluation]:
    return evaluate_instances(list(rows), HEAD, NOW)


def stale_row(name: str = "edge-traefik") -> HeartbeatRow:
    return make_row(name=name, last_seen=NOW - timedelta(minutes=10))


def events_of(logs: Sequence[Mapping[str, Any]]) -> list[str]:
    return [log["event"] for log in logs]


def test_first_observation_logs_nothing() -> None:
    monitor = InstanceMonitor()
    with capture_logs() as logs:
        monitor.observe(evaluate(make_row(name="a"), stale_row("b")), HEAD)
    assert logs == []


def test_down_then_recovered() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(make_row()), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(stale_row()), HEAD)
        monitor.observe(evaluate(make_row()), HEAD)
    assert [(log["event"], log["log_level"]) for log in logs] == [
        ("agent_down", "warning"),
        ("agent_recovered", "info"),
    ]


def test_new_name_after_seed_logs_agent_seen() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(make_row(name="a")), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(make_row(name="a"), make_row(name="b")), HEAD)
    assert events_of(logs) == ["agent_seen"]
    assert logs[0]["instance_name"] == "b"
    assert logs[0]["log_level"] == "info"


def test_self_is_ignored() -> None:
    monitor = InstanceMonitor()
    head_row = make_row(name="head", boot_id=HEAD_BOOT_ID)
    monitor.observe(evaluate(make_row(name="a")), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(make_row(name="a"), head_row), HEAD)
    assert logs == []


def test_persisting_problem_logs_once() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(make_row()), HEAD)
    with capture_logs() as logs:
        for _ in range(3):
            monitor.observe(evaluate(stale_row()), HEAD)
    assert events_of(logs) == ["agent_down"]


def test_removed_row_drops_silently_and_returns_as_seen() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(make_row(name="a"), stale_row("b")), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(make_row(name="a")), HEAD)
        assert logs == []
        monitor.observe(evaluate(make_row(name="a"), stale_row("b")), HEAD)
    assert events_of(logs) == ["agent_seen", "agent_down"]


def test_schema_mismatch_logs_warning_with_versions() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(make_row()), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(make_row(schema_revision="4b02d1", app_version="0.19.0")), HEAD)
    assert len(logs) == 1
    event = logs[0]
    assert event["event"] == "agent_schema_mismatch"
    assert event["log_level"] == "warning"
    assert event["instance_name"] == "edge-traefik"
    assert event["mode"] == "agent"
    assert event["app_version"] == "0.19.0"
    assert event["schema_revision"] == "4b02d1"
    assert event["head_app_version"] == "0.20.0"
    assert event["head_schema_revision"] == "7c1e9a"


def test_version_mismatch_logs_info() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(make_row()), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(make_row(app_version="0.19.0")), HEAD)
    assert [(log["event"], log["log_level"]) for log in logs] == [("agent_version_mismatch", "info")]


def test_problem_logs_again_after_it_clears() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(make_row()), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(make_row(app_version="0.19.0")), HEAD)
        monitor.observe(evaluate(make_row()), HEAD)
        monitor.observe(evaluate(make_row(app_version="0.19.0")), HEAD)
    assert events_of(logs) == ["agent_version_mismatch", "agent_version_mismatch"]



def writes_row(**counts: Any) -> HeartbeatRow:
    return make_row(payload={"instanceNameSource": "env", **counts})


SOME_FAILING = {"failed5M": 14, "written5M": 290, "failedBatches5M": 1}
ALL_FAILING = {"failed5M": 300, "written5M": 0, "failedBatches5M": 6}
RECOVERED = {"failed5M": 0, "written5M": 310, "failedBatches5M": 0}


def writes_events(logs: Sequence[Mapping[str, Any]]) -> list[tuple[Any, ...]]:
    return [
        (log["event"], log["log_level"], log["severity"], log["failed_5m"], log["written_5m"])
        for log in logs
        if log["event"].startswith("agent_writes")
    ]


def test_failing_writes_log_a_warning_with_the_counts() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(make_row()), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(writes_row(**SOME_FAILING)), HEAD)
    assert writes_events(logs) == [("agent_writes_failing", "warning", "warning", 14, 290)]
    assert logs[0]["instance_name"] == "edge-traefik"


def test_failing_writes_that_turn_critical_log_again() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(make_row()), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(writes_row(**SOME_FAILING)), HEAD)
        monitor.observe(evaluate(writes_row(**SOME_FAILING)), HEAD)
        monitor.observe(evaluate(writes_row(**ALL_FAILING)), HEAD)
        monitor.observe(evaluate(writes_row(**ALL_FAILING)), HEAD)
    assert writes_events(logs) == [
        ("agent_writes_failing", "warning", "warning", 14, 290),
        ("agent_writes_failing", "warning", "critical", 300, 0),
    ]


def test_failing_writes_that_ease_to_a_warning_log_nothing() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(writes_row(**ALL_FAILING)), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(writes_row(**SOME_FAILING)), HEAD)
    assert writes_events(logs) == []


def test_writes_recovering_log_info() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(writes_row(**ALL_FAILING)), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(writes_row(**RECOVERED)), HEAD)
    assert writes_events(logs) == [("agent_writes_recovered", "info", "critical", 0, 310)]


def test_agent_that_stops_checking_in_does_not_log_recovered_writes() -> None:
    monitor = InstanceMonitor()
    monitor.observe(evaluate(writes_row(**ALL_FAILING)), HEAD)
    with capture_logs() as logs:
        monitor.observe(evaluate(stale_row()), HEAD)
    assert events_of(logs) == ["agent_down"]


def test_failing_writes_at_the_first_observation_log_nothing() -> None:
    monitor = InstanceMonitor()
    with capture_logs() as logs:
        monitor.observe(evaluate(writes_row(**ALL_FAILING)), HEAD)
        monitor.observe(evaluate(writes_row(**ALL_FAILING)), HEAD)
    assert logs == []
