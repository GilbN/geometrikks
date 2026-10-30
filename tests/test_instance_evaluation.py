"""Evaluation of heartbeat rows into per-instance status and problems."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import msgspec
import pytest

from geometrikks.domain.instances.evaluation import (
    NOT_CHECKING_IN_AFTER,
    SKEW_ALLOWANCE,
    HeadIdentity,
    HeartbeatRow,
    evaluate_instance,
    evaluate_instances,
)
from geometrikks.domain.instances.models import InstanceHeartbeat

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
    mode: str = "agent",
    app_version: str = "0.20.0",
    schema_revision: str = "7c1e9a",
    last_seen: datetime = NOW - timedelta(seconds=10),
    payload: dict[str, Any] | None = None,
) -> HeartbeatRow:
    return HeartbeatRow(
        instance_name=name,
        boot_id=boot_id or uuid4(),
        mode=mode,
        app_version=app_version,
        schema_revision=schema_revision,
        started_at=NOW - timedelta(hours=2),
        last_seen=last_seen,
        payload={"instanceNameSource": "env"} if payload is None else payload,
    )


def problem_ids(row: HeartbeatRow) -> list[str]:
    return [problem.id for problem in evaluate_instance(row, HEAD, NOW).problems]


def advisory_payload(*advisories: dict[str, Any]) -> dict[str, Any]:
    return {"instanceNameSource": "env", "health": {"advisories": list(advisories)}}


def test_clean_agent_is_ok() -> None:
    evaluation = evaluate_instance(make_row(), HEAD, NOW)
    assert evaluation.status == "ok"
    assert evaluation.problems == []
    assert evaluation.checking_in is True
    assert evaluation.is_self is False


def test_from_model_copies_the_columns() -> None:
    model = InstanceHeartbeat(
        instance_name="edge-traefik",
        boot_id=uuid4(),
        mode="agent",
        app_version="0.20.0",
        schema_revision="7c1e9a",
        started_at=NOW,
        last_seen=NOW,
        payload={"a": 1},
    )
    row = HeartbeatRow.from_model(model)
    assert (row.instance_name, row.boot_id, row.mode, row.payload) == (
        "edge-traefik",
        model.boot_id,
        "agent",
        {"a": 1},
    )
    assert (row.app_version, row.schema_revision, row.started_at, row.last_seen) == (
        "0.20.0",
        "7c1e9a",
        NOW,
        NOW,
    )


def test_stale_row_is_not_checking_in() -> None:
    row = make_row(last_seen=NOW - NOT_CHECKING_IN_AFTER - timedelta(seconds=1))
    evaluation = evaluate_instance(row, HEAD, NOW)
    assert evaluation.checking_in is False
    assert evaluation.status == "critical"
    assert [problem.id for problem in evaluation.problems] == ["instance-not-checking-in"]
    assert "edge-traefik" in evaluation.problems[0].summary


def test_row_at_exactly_the_threshold_still_checks_in() -> None:
    row = make_row(last_seen=NOW - NOT_CHECKING_IN_AFTER)
    assert evaluate_instance(row, HEAD, NOW).checking_in is True


def test_stale_row_reports_only_not_checking_in() -> None:
    row = make_row(
        last_seen=NOW - timedelta(minutes=10),
        schema_revision="4b02d1",
        app_version="0.19.2",
        payload=advisory_payload({"id": "ingestion-stopped", "severity": "critical", "summary": "x"}),
    )
    assert problem_ids(row) == ["instance-not-checking-in"]


def test_self_is_matched_by_boot_id_not_name() -> None:
    impostor = make_row(name="head", mode="full", schema_revision="4b02d1")
    evaluation = evaluate_instance(impostor, HEAD, NOW)
    assert evaluation.is_self is False
    assert [problem.id for problem in evaluation.problems] == ["instance-schema-behind"]


def test_self_never_goes_stale() -> None:
    row = make_row(
        name="head",
        boot_id=HEAD_BOOT_ID,
        mode="full",
        last_seen=NOW - timedelta(hours=1),
        schema_revision="4b02d1",
        app_version="0.19.0",
    )
    evaluation = evaluate_instance(row, HEAD, NOW)
    assert evaluation.is_self is True
    assert evaluation.checking_in is True
    assert evaluation.problems == []
    assert evaluation.status == "ok"


def test_self_reports_a_name_conflict_and_forwarded_advisories_only() -> None:
    row = make_row(
        name="head",
        boot_id=HEAD_BOOT_ID,
        mode="full",
        payload={
            "instanceNameSource": "fallback",
            "nameConflictAt": (NOW - timedelta(minutes=1)).isoformat(),
            "recentStarts": [(NOW - timedelta(minutes=n)).isoformat() for n in (1, 2, 3)],
            "health": {
                "advisories": [{"id": "ingestion-stopped", "severity": "critical", "summary": "x"}],
                "ingestion": {"status": "degraded", "unavailableSources": [{"label": "/logs/a.log"}]},
            },
        },
    )
    assert problem_ids(row) == ["instance-name-conflict", "ingestion-stopped"]


def test_self_name_conflict_makes_the_head_critical() -> None:
    row = make_row(
        name="head",
        boot_id=HEAD_BOOT_ID,
        mode="full",
        payload={"instanceNameSource": "env", "nameConflictAt": (NOW - timedelta(minutes=1)).isoformat()},
    )
    evaluation = evaluate_instance(row, HEAD, NOW)
    assert [problem.summary for problem in evaluation.problems] == [
        "More than one process is using the name head."
    ]
    assert evaluation.status == "critical"


def test_self_name_conflict_older_than_five_minutes_is_ignored() -> None:
    row = make_row(
        name="head",
        boot_id=HEAD_BOOT_ID,
        mode="full",
        payload={"instanceNameSource": "env", "nameConflictAt": (NOW - timedelta(minutes=6)).isoformat()},
    )
    assert problem_ids(row) == []


def test_schema_behind_when_revision_is_known() -> None:
    row = make_row(schema_revision="4b02d1", app_version="0.19.2")
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert problem.id == "instance-schema-behind"
    assert problem.severity == "critical"
    assert problem.summary == "edge-traefik runs an older database migration than the head."
    assert (problem.detail or "").startswith(
        "Agent edge-traefik runs v0.19.2 on migration 4b02d1; the head runs v0.20.0 on migration 7c1e9a."
    )
    assert problem.remedy == "Upgrade edge-traefik to v0.20.0."


def test_schema_behind_names_the_head_when_it_is_a_local_build() -> None:
    local_head = HeadIdentity(
        boot_id=HEAD_BOOT_ID,
        instance_name="head",
        app_version="0.0.0+local",
        schema_revision="7c1e9a",
        known_revisions=frozenset({"4b02d1", "7c1e9a"}),
    )
    row = make_row(schema_revision="4b02d1", app_version="0.19.2")
    problem = evaluate_instance(row, local_head, NOW).problems[0]
    assert problem.id == "instance-schema-behind"
    assert problem.remedy == "Upgrade edge-traefik to the head's version."


def test_schema_ahead_when_revision_is_unknown() -> None:
    row = make_row(schema_revision="ffffff", app_version="0.21.0")
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert problem.id == "instance-schema-ahead"
    assert problem.severity == "critical"
    assert problem.summary == "The head does not recognize the migration ffffff of edge-traefik."
    assert "v0.21.0 on migration ffffff" in (problem.detail or "")
    assert problem.remedy == "Upgrade the head, or check which version edge-traefik runs."


def test_name_conflict_within_five_minutes() -> None:
    row = make_row(payload={"instanceNameSource": "env", "nameConflictAt": (NOW - timedelta(minutes=2)).isoformat()})
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert problem.id == "instance-name-conflict"
    assert problem.severity == "critical"
    assert "APP_INSTANCE_NAME" in (problem.remedy or "")


def test_name_conflict_older_than_five_minutes_is_ignored() -> None:
    row = make_row(payload={"instanceNameSource": "env", "nameConflictAt": (NOW - timedelta(minutes=6)).isoformat()})
    assert problem_ids(row) == []


def test_forwarded_critical_advisory_keeps_its_text() -> None:
    row = make_row(
        payload=advisory_payload(
            {
                "id": "ingestion-stopped",
                "severity": "critical",
                "summary": "Log ingestion stopped.",
                "detail": "Check the log.",
                "remedy": "Restart.",
                "docsUrl": "https://example.test/docs",
            }
        )
    )
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert (problem.id, problem.severity, problem.summary) == ("ingestion-stopped", "critical", "Log ingestion stopped.")
    assert (problem.detail, problem.remedy, problem.docs_url) == (
        "Check the log.",
        "Restart.",
        "https://example.test/docs",
    )


def test_version_mismatch_on_same_revision() -> None:
    row = make_row(app_version="0.19.9")
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert problem.id == "instance-version-mismatch"
    assert problem.severity == "warning"
    assert "v0.19.9" in problem.summary
    assert "v0.20.0" in problem.summary
    assert problem.remedy == "Run the same GeoMetrikks version on the head and edge-traefik."


def test_version_mismatch_ignores_local_suffix() -> None:
    assert problem_ids(make_row(app_version="0.20.0+g52b67d62c")) == []


def test_version_mismatch_skipped_for_local_build() -> None:
    assert problem_ids(make_row(app_version="0.0.0+local")) == []


def test_version_mismatch_shows_tag_style() -> None:
    problem = evaluate_instance(make_row(app_version="0.20.0.dev3"), HEAD, NOW).problems[0]
    assert problem.id == "instance-version-mismatch"
    assert "v0.20.0-dev.3" in problem.summary


def test_name_not_set_on_agent_with_fallback_name() -> None:
    row = make_row(name="agent", payload={"instanceNameSource": "fallback"})
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert problem.id == "instance-name-not-set"
    assert problem.severity == "warning"
    assert problem.summary == 'This agent runs under the default name "agent".'
    assert "APP_INSTANCE_NAME" in (problem.remedy or "")


def test_name_not_set_ignores_full_mode() -> None:
    row = make_row(name="head", mode="full", payload={"instanceNameSource": "fallback"})
    assert problem_ids(row) == []


def test_restart_loop_at_three_starts_in_an_hour() -> None:
    starts = [(NOW - timedelta(minutes=minutes)).isoformat() for minutes in (5, 20, 50)]
    row = make_row(payload={"instanceNameSource": "env", "recentStarts": starts})
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert problem.id == "instance-restart-loop"
    assert problem.severity == "warning"
    assert "3 times" in problem.summary


def test_two_restarts_in_an_hour_is_not_a_loop() -> None:
    starts = [(NOW - timedelta(minutes=minutes)).isoformat() for minutes in (5, 20, 90)]
    row = make_row(payload={"instanceNameSource": "env", "recentStarts": starts})
    assert problem_ids(row) == []


def test_forwarded_warning_advisory_stays_a_warning() -> None:
    row = make_row(payload=advisory_payload({"id": "geoip-database-missing", "severity": "warning", "summary": "x"}))
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert (problem.id, problem.severity) == ("geoip-database-missing", "warning")


def test_unknown_forwarded_severity_becomes_warning() -> None:
    row = make_row(payload=advisory_payload({"id": "future-thing", "severity": "notice", "summary": "x"}))
    evaluation = evaluate_instance(row, HEAD, NOW)
    assert [(problem.id, problem.severity) for problem in evaluation.problems] == [("future-thing", "warning")]
    assert evaluation.status == "warning"


def test_forwarded_proxy_peer_cdn_is_dropped() -> None:
    row = make_row(
        payload=advisory_payload(
            {"id": "proxy-peer-cdn", "severity": "warning", "summary": "x"},
            {"id": "proxy-peer-private", "severity": "warning", "summary": "y"},
        )
    )
    assert problem_ids(row) == ["proxy-peer-private"]


def test_unreadable_payload_is_a_warning() -> None:
    row = make_row(payload={"jobs": "not a list"})
    evaluation = evaluate_instance(row, HEAD, NOW)
    assert evaluation.payload is None
    assert evaluation.status == "warning"
    assert [problem.id for problem in evaluation.problems] == ["instance-payload-unreadable"]


def test_unreadable_payload_still_gets_column_rules() -> None:
    row = make_row(payload={"jobs": "not a list"}, schema_revision="4b02d1")
    assert problem_ids(row) == ["instance-schema-behind", "instance-payload-unreadable"]


def test_problems_list_critical_first_then_warning_in_table_order() -> None:
    row = make_row(
        name="agent",
        schema_revision="4b02d1",
        app_version="0.19.2",
        payload={
            "instanceNameSource": "fallback",
            "nameConflictAt": (NOW - timedelta(minutes=1)).isoformat(),
            "recentStarts": [(NOW - timedelta(minutes=n)).isoformat() for n in (1, 2, 3)],
            "health": {
                "advisories": [
                    {"id": "geoip-database-missing", "severity": "warning", "summary": "w"},
                    {"id": "ingestion-stopped", "severity": "critical", "summary": "c"},
                ]
            },
        },
    )
    evaluation = evaluate_instance(row, HEAD, NOW)
    assert [problem.id for problem in evaluation.problems] == [
        "instance-schema-behind",
        "instance-name-conflict",
        "ingestion-stopped",
        "instance-name-not-set",
        "instance-restart-loop",
        "geoip-database-missing",
    ]
    assert evaluation.status == "critical"


def test_ordering_self_then_severity_then_name() -> None:
    self_row = make_row(name="head", boot_id=HEAD_BOOT_ID, mode="full")
    ok_row = make_row(name="alpha")
    warning_row = make_row(name="beta", app_version="0.19.9")
    other_warning_row = make_row(name="aaa-warn", app_version="0.19.9")
    critical_row = make_row(name="zeta", last_seen=NOW - timedelta(hours=1))
    evaluations = evaluate_instances(
        [ok_row, warning_row, critical_row, other_warning_row, self_row], HEAD, NOW
    )
    assert [evaluation.row.instance_name for evaluation in evaluations] == [
        "head",
        "zeta",
        "aaa-warn",
        "beta",
        "alpha",
    ]


@pytest.mark.parametrize("name", ["edge-traefik", "web 01"])
def test_messages_name_the_instance(name: str) -> None:
    row = make_row(name=name, schema_revision="4b02d1")
    assert name in evaluate_instance(row, HEAD, NOW).problems[0].summary


def test_naive_payload_timestamps_are_read_as_utc() -> None:
    naive_conflict = (NOW - timedelta(minutes=1)).replace(tzinfo=None).isoformat()
    naive_starts = [(NOW - timedelta(minutes=n)).replace(tzinfo=None).isoformat() for n in (1, 2, 3)]
    naive_row = make_row(
        name="naive",
        payload={"instanceNameSource": "env", "nameConflictAt": naive_conflict, "recentStarts": naive_starts},
    )
    clean_row = make_row(name="clean")
    evaluations = evaluate_instances([naive_row, clean_row], HEAD, NOW)
    by_name = {evaluation.row.instance_name: evaluation for evaluation in evaluations}
    assert [problem.id for problem in by_name["naive"].problems] == [
        "instance-name-conflict",
        "instance-restart-loop",
    ]
    assert by_name["clean"].status == "ok"


def test_unknown_head_version_is_not_a_mismatch() -> None:
    unknown_head = HeadIdentity(
        boot_id=HEAD_BOOT_ID,
        instance_name="head",
        app_version="unknown",
        schema_revision="7c1e9a",
        known_revisions=frozenset({"4b02d1", "7c1e9a"}),
    )
    assert evaluate_instance(make_row(app_version="0.19.9"), unknown_head, NOW).problems == []


def test_unknown_agent_version_is_shown_as_local_build() -> None:
    row = make_row(app_version="unknown", schema_revision="4b02d1")
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert "runs local build on migration 4b02d1" in (problem.detail or "")
    assert "vunknown" not in (problem.detail or "")


def test_name_conflict_from_a_clock_slightly_ahead_still_shows() -> None:
    row = make_row(payload={"instanceNameSource": "env", "nameConflictAt": (NOW + timedelta(minutes=4)).isoformat()})
    assert problem_ids(row) == ["instance-name-conflict"]


def test_name_conflict_at_the_skew_allowance_still_shows() -> None:
    row = make_row(
        payload={"instanceNameSource": "env", "nameConflictAt": (NOW + SKEW_ALLOWANCE).isoformat()}
    )
    assert problem_ids(row) == ["instance-name-conflict"]


def test_name_conflict_beyond_the_skew_allowance_is_ignored() -> None:
    conflict_at = NOW + SKEW_ALLOWANCE + timedelta(seconds=1)
    row = make_row(payload={"instanceNameSource": "env", "nameConflictAt": conflict_at.isoformat()})
    assert problem_ids(row) == []


def test_starts_from_a_clock_slightly_ahead_count_toward_a_restart_loop() -> None:
    starts = [(NOW + timedelta(minutes=minutes)).isoformat() for minutes in (-20, 3, 6)]
    row = make_row(payload={"instanceNameSource": "env", "recentStarts": starts})
    assert problem_ids(row) == ["instance-restart-loop"]


def test_starts_beyond_the_skew_allowance_do_not_count_toward_a_restart_loop() -> None:
    starts = [(NOW - timedelta(minutes=5)).isoformat()] + [(NOW + timedelta(hours=n)).isoformat() for n in (1, 2)]
    row = make_row(payload={"instanceNameSource": "env", "recentStarts": starts})
    assert problem_ids(row) == []


def ingestion_payload(ingestion: dict[str, Any], **payload_fields: Any) -> dict[str, Any]:
    return {"instanceNameSource": "env", "health": {"ingestion": ingestion}, **payload_fields}


def test_unavailable_source_is_an_ingestion_warning() -> None:
    row = make_row(
        payload=ingestion_payload(
            {"status": "running", "unavailableSources": [{"kind": "file", "label": "/logs/access.log"}]}
        )
    )
    evaluation = evaluate_instance(row, HEAD, NOW)
    problem = evaluation.problems[0]
    assert problem.id == "instance-ingestion-degraded"
    assert problem.severity == "warning"
    assert problem.summary == "edge-traefik cannot read /logs/access.log."
    assert problem.remedy == "Check the log paths or Loki settings on edge-traefik."
    assert evaluation.status == "warning"


def test_ingestion_warning_prefers_the_payload_source_labels() -> None:
    row = make_row(
        payload=ingestion_payload(
            {"status": "running", "unavailableSources": [{"kind": "loki", "label": "loki:1"}]},
            sources=[
                {"kind": "loki", "label": '{job="traefik"}', "available": False},
                {"kind": "file", "label": "/logs/ok.log", "available": True},
            ],
        )
    )
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert problem.summary == 'edge-traefik cannot read {job="traefik"}.'


def test_ingestion_warning_names_three_sources_and_counts_the_rest() -> None:
    labels = [f"/logs/{index}.log" for index in range(5)]
    row = make_row(
        payload=ingestion_payload(
            {"status": "running", "unavailableSources": [{"label": label} for label in labels]}
        )
    )
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert problem.summary == "edge-traefik cannot read /logs/0.log, /logs/1.log, /logs/2.log and 2 more."


def test_degraded_ingestion_without_sources_is_a_warning() -> None:
    row = make_row(payload=ingestion_payload({"status": "degraded", "unavailableSources": []}))
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert problem.id == "instance-ingestion-degraded"
    assert problem.summary == "Ingestion on edge-traefik is not running."


def test_degraded_ingestion_without_sources_points_at_the_agent_log() -> None:
    row = make_row(payload=ingestion_payload({"status": "degraded", "unavailableSources": []}))
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert problem.remedy == "Check the log of edge-traefik for why ingestion stopped."


@pytest.mark.parametrize("explaining_advisory_id", ["geoip-database-missing", "ingestion-stopped", "database-unavailable"])
def test_degraded_ingestion_stays_quiet_when_a_forwarded_advisory_explains_it(explaining_advisory_id: str) -> None:
    payload = ingestion_payload({"status": "degraded", "unavailableSources": []})
    payload["health"]["advisories"] = [
        {"id": explaining_advisory_id, "severity": "critical", "summary": "the real cause"}
    ]
    assert problem_ids(make_row(payload=payload)) == [explaining_advisory_id]


def test_degraded_ingestion_stays_quiet_on_a_migration_mismatch() -> None:
    row = make_row(
        schema_revision="4b02d1",
        payload=ingestion_payload({"status": "degraded", "unavailableSources": []}),
    )
    assert problem_ids(row) == ["instance-schema-behind"]


@pytest.mark.parametrize("schema_wait", ["waiting", "timeout"])
def test_degraded_ingestion_stays_quiet_during_the_schema_wait(schema_wait: str) -> None:
    payload = ingestion_payload({"status": "degraded", "unavailableSources": []})
    payload["health"]["schemaWait"] = schema_wait
    assert problem_ids(make_row(payload=payload)) == []


def test_unreadable_sources_are_reported_even_when_another_cause_is_forwarded() -> None:
    payload = ingestion_payload({"status": "degraded", "unavailableSources": [{"label": "/logs/access.log"}]})
    payload["health"]["advisories"] = [
        {"id": "ingestion-stopped", "severity": "critical", "summary": "the real cause"}
    ]
    assert problem_ids(make_row(payload=payload)) == ["ingestion-stopped", "instance-ingestion-degraded"]


def test_disabled_ingestion_is_not_a_problem() -> None:
    row = make_row(
        payload=ingestion_payload({"status": "disabled", "unavailableSources": [{"label": "/logs/a.log"}]})
    )
    assert problem_ids(row) == []


def test_running_ingestion_is_not_a_problem() -> None:
    row = make_row(payload=ingestion_payload({"status": "running", "unavailableSources": []}))
    assert problem_ids(row) == []


def test_ingestion_warning_sits_after_the_other_computed_warnings() -> None:
    row = make_row(
        name="agent",
        app_version="0.19.9",
        payload=ingestion_payload(
            {"status": "degraded"},
            instanceNameSource="fallback",
            recentStarts=[(NOW - timedelta(minutes=n)).isoformat() for n in (1, 2, 3)],
        ),
    )
    assert problem_ids(row) == [
        "instance-version-mismatch",
        "instance-name-not-set",
        "instance-restart-loop",
        "instance-ingestion-degraded",
    ]


def test_forwarded_advisory_with_the_ingestion_id_loses_to_the_computed_one() -> None:
    payload = ingestion_payload({"status": "degraded"})
    payload["health"]["advisories"] = [
        {"id": "instance-ingestion-degraded", "severity": "critical", "summary": "forged"}
    ]
    evaluation = evaluate_instance(make_row(payload=payload), HEAD, NOW)
    assert [(problem.id, problem.severity) for problem in evaluation.problems] == [
        ("instance-ingestion-degraded", "warning")
    ]


def test_stale_agent_reports_only_not_checking_in_despite_degraded_ingestion() -> None:
    row = make_row(
        last_seen=NOW - NOT_CHECKING_IN_AFTER - timedelta(seconds=1),
        payload=ingestion_payload({"status": "degraded"}),
    )
    assert problem_ids(row) == ["instance-not-checking-in"]


def test_name_conflict_exactly_five_minutes_old_still_shows() -> None:
    row = make_row(payload={"instanceNameSource": "env", "nameConflictAt": (NOW - timedelta(minutes=5)).isoformat()})
    assert problem_ids(row) == ["instance-name-conflict"]


def test_restart_loop_counts_a_start_exactly_one_hour_old() -> None:
    starts = [(NOW - timedelta(minutes=minutes)).isoformat() for minutes in (1, 30, 60)]
    row = make_row(payload={"instanceNameSource": "env", "recentStarts": starts})
    assert problem_ids(row) == ["instance-restart-loop"]


def test_forwarded_advisory_with_a_computed_id_loses_to_the_computed_problem() -> None:
    row = make_row(
        app_version="0.19.9",
        payload=advisory_payload({"id": "instance-version-mismatch", "severity": "critical", "summary": "forged"}),
    )
    evaluation = evaluate_instance(row, HEAD, NOW)
    assert [(problem.id, problem.severity) for problem in evaluation.problems] == [
        ("instance-version-mismatch", "warning")
    ]
    assert evaluation.status == "warning"


def test_repeated_forwarded_id_keeps_the_first() -> None:
    row = make_row(
        payload=advisory_payload(
            {"id": "geoip-database-missing", "severity": "warning", "summary": "first"},
            {"id": "geoip-database-missing", "severity": "warning", "summary": "second"},
        )
    )
    problems = evaluate_instance(row, HEAD, NOW).problems
    assert [problem.summary for problem in problems] == ["first"]


def test_age_text_is_singular_safe() -> None:
    from geometrikks.domain.instances.evaluation import _age_text

    assert _age_text(timedelta(minutes=1, seconds=5)) == "1 minute ago"
    assert _age_text(timedelta(hours=1, minutes=5)) == "1 hour ago"
    assert _age_text(timedelta(days=3)) == "3 days ago"


def test_unreadable_payload_remedy_names_the_check() -> None:
    row = make_row(payload={"jobs": "not a list"})
    problem = evaluate_instance(row, HEAD, NOW).problems[0]
    assert problem.remedy == "Check that edge-traefik runs the same GeoMetrikks version as the head."


COUNTRY_CODE_ERROR = (
    "(sqlalchemy.dialects.postgresql.asyncpg.IntegrityError) "
    "<class 'asyncpg.exceptions.NotNullViolationError'>: null value in column "
    '"country_code" of relation "geo_events" violates not-null constraint\n'
    "[SQL: INSERT INTO geo_events ...]"
)
SECRET_ARGUMENT_ERROR = (
    "(sqlalchemy.dialects.postgresql.asyncpg.Error) <class 'asyncpg.exceptions.DataError'>: "
    "invalid input for query argument $4: '/login?token=s3cr3t' (expected str, got int)"
)


def writes_payload(**payload_fields: Any) -> dict[str, Any]:
    return {"instanceNameSource": "env", **payload_fields}


def failing_payload(**payload_fields: Any) -> dict[str, Any]:
    """Writes that keep failing: many failed batches and nothing written."""
    return writes_payload(**{"failed5M": 1200, "written5M": 0, "failedBatches5M": 12, **payload_fields})


def test_some_failed_writes_are_a_warning() -> None:
    evaluation = evaluate_instance(
        make_row(payload=writes_payload(failed5M=14, written5M=290, failedBatches5M=3)), HEAD, NOW
    )
    [problem] = evaluation.problems
    assert (problem.id, problem.severity) == ("instance-writes-failing", "warning")
    assert problem.summary == "edge-traefik could not write 14 of 304 records in the last 5 minutes."
    assert problem.remedy == "Check the log of edge-traefik for ingestion_batch_failed."
    assert evaluation.status == "warning"


def test_writes_that_keep_failing_are_critical() -> None:
    evaluation = evaluate_instance(make_row(payload=failing_payload()), HEAD, NOW)
    [problem] = evaluation.problems
    assert (problem.id, problem.severity) == ("instance-writes-failing", "critical")
    assert problem.summary == "Every write from edge-traefik failed in the last 5 minutes."
    assert problem.detail == "It lost 1,200 records in 12 batches and does not retry them."
    assert evaluation.status == "critical"


def test_one_failed_batch_with_nothing_written_is_a_warning() -> None:
    payload = writes_payload(failed5M=1, written5M=0, failedBatches5M=1)
    [problem] = evaluate_instance(make_row(payload=payload), HEAD, NOW).problems
    assert problem.severity == "warning"
    assert problem.summary == "edge-traefik could not write 1 of 1 record in the last 5 minutes."


@pytest.mark.parametrize("missing_count", ["written5M", "failedBatches5M"])
def test_failed_writes_from_an_agent_without_every_count_are_a_warning(missing_count: str) -> None:
    payload = failing_payload()
    del payload[missing_count]
    [problem] = evaluate_instance(make_row(payload=payload), HEAD, NOW).problems
    assert problem.severity == "warning"


def test_failed_writes_without_a_written_count_name_only_the_failures() -> None:
    [problem] = evaluate_instance(make_row(payload=writes_payload(failed5M=1)), HEAD, NOW).problems
    assert problem.summary == "edge-traefik could not write 1 record in the last 5 minutes."


def test_failed_writes_quote_the_last_error_without_its_exception_prefixes() -> None:
    payload = failing_payload(lastError={"message": COUNTRY_CODE_ERROR})
    [problem] = evaluate_instance(make_row(payload=payload), HEAD, NOW).problems
    assert problem.detail == (
        'The last error was: null value in column "country_code" of relation "geo_events" '
        "violates not-null constraint. It lost 1,200 records in 12 batches and does not retry them."
    )


def test_failed_writes_hide_the_values_a_bound_argument_error_quotes() -> None:
    payload = failing_payload(lastError={"message": SECRET_ARGUMENT_ERROR})
    [problem] = evaluate_instance(make_row(payload=payload), HEAD, NOW).problems
    assert "s3cr3t" not in msgspec.json.encode(problem).decode()
    assert (problem.detail or "").startswith("The last error was: invalid input for query argument $4.")


def test_failed_writes_without_a_last_error_skip_that_sentence() -> None:
    payload = writes_payload(failed5M=14, written5M=3, failedBatches5M=1)
    [problem] = evaluate_instance(make_row(payload=payload), HEAD, NOW).problems
    assert problem.detail == "edge-traefik drops the records it cannot write and does not retry them."


@pytest.mark.parametrize("failed_count", [None, 0])
def test_no_recent_failed_writes_is_not_a_problem(failed_count: int | None) -> None:
    payload = failing_payload(failed5M=failed_count, lastError={"message": "old failure"})
    assert problem_ids(make_row(payload=payload)) == []


def test_stale_agent_reports_only_not_checking_in_despite_failed_writes() -> None:
    row = make_row(
        last_seen=NOW - NOT_CHECKING_IN_AFTER - timedelta(seconds=1),
        payload=failing_payload(lastError={"message": COUNTRY_CODE_ERROR}),
    )
    assert problem_ids(row) == ["instance-not-checking-in"]


@pytest.mark.parametrize("forwarded_severity", ["warning", "critical"])
def test_failed_writes_replace_the_agents_own_write_failure_advisory(forwarded_severity: str) -> None:
    payload = writes_payload(failed5M=14, written5M=290, failedBatches5M=1)
    payload["health"] = {
        "advisories": [
            {"id": "ingestion-write-failures", "severity": forwarded_severity, "summary": "9 batches since startup"}
        ]
    }
    evaluation = evaluate_instance(make_row(payload=payload), HEAD, NOW)
    assert [(problem.id, problem.severity) for problem in evaluation.problems] == [
        ("instance-writes-failing", "warning")
    ]


def test_agents_own_write_failure_advisory_stays_once_writes_recover() -> None:
    payload = writes_payload(failed5M=0, written5M=290)
    payload["health"] = {
        "advisories": [
            {"id": "ingestion-write-failures", "severity": "warning", "summary": "9 batches since startup"}
        ]
    }
    assert problem_ids(make_row(payload=payload)) == ["ingestion-write-failures"]


def test_agents_own_critical_write_failures_count_before_the_first_window() -> None:
    payload = writes_payload(failed5M=None)
    payload["health"] = {
        "advisories": [{"id": "ingestion-write-failures", "severity": "critical", "summary": "x"}]
    }
    evaluation = evaluate_instance(make_row(payload=payload), HEAD, NOW)
    assert [(problem.id, problem.severity) for problem in evaluation.problems] == [
        ("ingestion-write-failures", "critical")
    ]
    assert evaluation.status == "critical"


def test_critical_failed_writes_sit_with_the_computed_criticals() -> None:
    payload = failing_payload()
    payload["health"] = {"advisories": [{"id": "ingestion-stopped", "severity": "critical", "summary": "x"}]}
    row = make_row(schema_revision="4b02d1", payload=payload)
    assert problem_ids(row) == ["instance-schema-behind", "instance-writes-failing", "ingestion-stopped"]


def test_partial_failed_writes_sit_after_the_ingestion_warning() -> None:
    row = make_row(
        payload=ingestion_payload(
            {"status": "running", "unavailableSources": [{"label": "/logs/a.log"}]},
            failed5M=2,
            written5M=10,
            failedBatches5M=1,
        )
    )
    assert problem_ids(row) == ["instance-ingestion-degraded", "instance-writes-failing"]
