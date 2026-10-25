"""Turn heartbeat rows into a status and a list of problems per instance.

Pure: the caller passes the head's identity and the current time, and nothing
here reads a clock or touches the database. The API and the scheduled check
both call it so the rules live in one place.
"""
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Self
from uuid import UUID

from geometrikks.domain.instances.models import InstanceHeartbeat
from geometrikks.domain.instances.schemas import (
    ForwardedAdvisory,
    HeartbeatPayload,
    decode_payload,
    payload_advisories,
)
from geometrikks.lib.advisories import (
    CITY_DATABASE_MISSING,
    DATABASE_UNAVAILABLE,
    INGESTION_STOPPED,
    Advisory,
)
from geometrikks.lib.versioning import display_version, is_local_build, same_release

NOT_CHECKING_IN_AFTER = timedelta(seconds=180)
NAME_CONFLICT_SHOWN_FOR = timedelta(minutes=5)
RESTART_LOOP_STARTS = 3
RESTART_LOOP_WINDOW = timedelta(hours=1)
# name_conflict_at and recent_starts come from the agent's wall clock, so an
# agent running a few minutes ahead must still count.
SKEW_ALLOWANCE = timedelta(minutes=10)
UNAVAILABLE_SOURCES_NAMED = 3

DROPPED_FORWARDED_IDS = frozenset({"proxy-peer-cdn"})
INGESTION_STOP_CAUSES = frozenset({CITY_DATABASE_MISSING.id, INGESTION_STOPPED.id, DATABASE_UNAVAILABLE.id})
SCHEMA_WAIT_BLOCKING = frozenset({"waiting", "timeout"})

InstanceStatus = Literal["ok", "warning", "critical"]


@dataclass(frozen=True, slots=True)
class HeadIdentity:
    boot_id: UUID
    instance_name: str
    app_version: str
    schema_revision: str
    known_revisions: frozenset[str]


@dataclass(frozen=True, slots=True)
class HeartbeatRow:
    instance_name: str
    boot_id: UUID
    mode: str
    app_version: str
    schema_revision: str
    started_at: datetime
    last_seen: datetime
    payload: dict[str, Any]

    @classmethod
    def from_model(cls, model: InstanceHeartbeat) -> Self:
        return cls(
            instance_name=model.instance_name,
            boot_id=model.boot_id,
            mode=model.mode,
            app_version=model.app_version,
            schema_revision=model.schema_revision,
            started_at=model.started_at,
            last_seen=model.last_seen,
            payload=model.payload,
        )


@dataclass(frozen=True, slots=True)
class InstanceEvaluation:
    row: HeartbeatRow
    payload: HeartbeatPayload | None
    is_self: bool
    checking_in: bool
    status: InstanceStatus
    problems: list[Advisory]


def _ago(count: int, unit: str) -> str:
    return f"{count} {unit} ago" if count == 1 else f"{count} {unit}s ago"


def _age_text(age: timedelta) -> str:
    minutes = int(age.total_seconds() // 60)
    if minutes < 60:
        return _ago(minutes, "minute")
    hours = minutes // 60
    if hours < 48:
        return _ago(hours, "hour")
    return _ago(hours // 24, "day")


def _within(now: datetime, timestamp: datetime, window: timedelta) -> bool:
    """True when timestamp is at most window old, or at most SKEW_ALLOWANCE in
    the future. A naive timestamp is read as UTC."""
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)
    return -SKEW_ALLOWANCE <= now - timestamp <= window


def _forwarded(advisory: ForwardedAdvisory, severity: Literal["warning", "critical"]) -> Advisory:
    return Advisory(
        id=advisory.id,
        severity=severity,
        summary=advisory.summary,
        detail=advisory.detail,
        remedy=advisory.remedy,
        docs_url=advisory.docs_url,
    )


def _not_checking_in(row: HeartbeatRow, now: datetime) -> Advisory:
    return Advisory(
        id="instance-not-checking-in",
        severity="critical",
        summary=f"{row.instance_name} stopped checking in.",
        detail=(
            f"Last seen {_age_text(now - row.last_seen)}. The agent writes a "
            "heartbeat every 30 seconds, so it is stopped, cannot reach the "
            "database, or lost its network."
        ),
        remedy=(
            f"Start {row.instance_name} again, or remove it from the list if "
            "you shut it down on purpose."
        ),
    )


def _schema_mismatch(row: HeartbeatRow, head: HeadIdentity) -> Advisory:
    versions = (
        f"Agent {row.instance_name} runs {display_version(row.app_version)} on migration {row.schema_revision}; "
        f"the head runs {display_version(head.app_version)} on migration {head.schema_revision}."
    )
    if row.schema_revision in head.known_revisions:
        target = "the head's version" if is_local_build(head.app_version) else display_version(head.app_version)
        return Advisory(
            id="instance-schema-behind",
            severity="critical",
            summary=f"{row.instance_name} runs an older database migration than the head.",
            detail=f"{versions} Its writes may fail until it catches up.",
            remedy=f"Upgrade {row.instance_name} to {target}.",
        )
    return Advisory(
        id="instance-schema-ahead",
        severity="critical",
        summary=f"The head does not recognize the migration {row.schema_revision} of {row.instance_name}.",
        detail=f"{versions} That usually means {row.instance_name} runs a newer release than the head.",
        remedy=f"Upgrade the head, or check which version {row.instance_name} runs.",
    )


def _name_conflict(row: HeartbeatRow) -> Advisory:
    return Advisory(
        id="instance-name-conflict",
        severity="critical",
        summary=f"More than one process is using the name {row.instance_name}.",
        detail="Their heartbeats overwrite each other, so this row can show only one of them.",
        remedy="Give each instance its own APP_INSTANCE_NAME.",
    )


def _version_mismatch(row: HeartbeatRow, head: HeadIdentity) -> Advisory:
    return Advisory(
        id="instance-version-mismatch",
        severity="warning",
        summary=(
            f"Agent {row.instance_name} runs {display_version(row.app_version)}; the head runs "
            f"{display_version(head.app_version)}. Both are on migration {head.schema_revision}."
        ),
        detail="The database schema matches, but the code differs, so behavior can drift.",
        remedy=f"Run the same GeoMetrikks version on the head and {row.instance_name}.",
    )


def _name_not_set(row: HeartbeatRow) -> Advisory:
    return Advisory(
        id="instance-name-not-set",
        severity="warning",
        summary=f'This agent runs under the default name "{row.instance_name}".',
        detail=(
            "A second agent with the default name would overwrite this row "
            "instead of showing up beside it."
        ),
        remedy="Set APP_INSTANCE_NAME on the agent.",
    )


def _restart_loop(row: HeartbeatRow, start_count: int) -> Advisory:
    return Advisory(
        id="instance-restart-loop",
        severity="warning",
        summary=f"{row.instance_name} started {start_count} times in the last hour.",
        detail="It keeps stopping and coming back, which usually means it crashes on startup or gets killed.",
        remedy=f"Check the container logs of {row.instance_name}.",
    )


def _unavailable_source_labels(payload: HeartbeatPayload) -> list[str]:
    """Labels of the sources the agent cannot read.

    payload.sources comes first because it labels a Loki source by its query,
    where the health report only has loki:1.
    """
    source_labels = [source.label for source in payload.sources if not source.available]
    if source_labels:
        return source_labels
    ingestion_health = payload.health.get("ingestion")
    if not isinstance(ingestion_health, dict):
        return []
    raw_sources = ingestion_health.get("unavailableSources")
    if not isinstance(raw_sources, list):
        return []
    return [
        raw_source["label"]
        for raw_source in raw_sources
        if isinstance(raw_source, dict) and isinstance(raw_source.get("label"), str)
    ]


def _stopped_for_a_known_reason(row: HeartbeatRow, payload: HeartbeatPayload, head: HeadIdentity) -> bool:
    """Whether another problem already explains ingestion not running.

    A missing GeoLite2 database, a stopped ingestion task, an unreachable
    database, a migration mismatch and the startup schema wait all stop
    ingestion, and each one is reported on its own with the right fix.
    """
    if row.schema_revision != head.schema_revision:
        return True
    if payload.health.get("schemaWait") in SCHEMA_WAIT_BLOCKING:
        return True
    forwarded_ids = {advisory.id for advisory in payload_advisories(payload)}
    return not forwarded_ids.isdisjoint(INGESTION_STOP_CAUSES)


def _ingestion_degraded(row: HeartbeatRow, payload: HeartbeatPayload, head: HeadIdentity) -> Advisory | None:
    ingestion_health = payload.health.get("ingestion")
    if not isinstance(ingestion_health, dict):
        return None
    ingestion_status = ingestion_health.get("status")
    if ingestion_status == "disabled":
        return None
    source_labels = _unavailable_source_labels(payload)
    if ingestion_status != "degraded" and not source_labels:
        return None
    if not source_labels:
        if _stopped_for_a_known_reason(row, payload, head):
            return None
        return Advisory(
            id="instance-ingestion-degraded",
            severity="warning",
            summary=f"Ingestion on {row.instance_name} is not running.",
            detail="Its health report says ingestion is degraded, so no new requests from it reach the database.",
            remedy=f"Check the log of {row.instance_name} for why ingestion stopped.",
        )
    named_labels = ", ".join(source_labels[:UNAVAILABLE_SOURCES_NAMED])
    hidden_count = len(source_labels) - UNAVAILABLE_SOURCES_NAMED
    if hidden_count > 0:
        named_labels = f"{named_labels} and {hidden_count} more"
    return Advisory(
        id="instance-ingestion-degraded",
        severity="warning",
        summary=f"{row.instance_name} cannot read {named_labels}.",
        detail="Requests from these sources stop reaching the database until the agent can read them again.",
        remedy=f"Check the log paths or Loki settings on {row.instance_name}.",
    )


def _payload_unreadable(row: HeartbeatRow, head: HeadIdentity) -> Advisory:
    return Advisory(
        id="instance-payload-unreadable",
        severity="warning",
        summary=f"The health report from {row.instance_name} could not be read.",
        detail=(
            "The version, migration and last seen time are still shown. "
            f"{row.instance_name} runs {display_version(row.app_version)}; "
            f"the head runs {display_version(head.app_version)}."
        ),
        remedy=f"Check that {row.instance_name} runs the same GeoMetrikks version as the head.",
    )


def evaluate_instance(row: HeartbeatRow, head: HeadIdentity, now: datetime) -> InstanceEvaluation:
    is_self = row.boot_id == head.boot_id
    payload = decode_payload(row.payload)

    if is_self:
        self_problems = [_name_conflict(row)] if _has_name_conflict(payload, now) else []
        self_problems += _forwarded_problems(payload)
        return _evaluation(row, payload, is_self=True, checking_in=True, problems=self_problems)

    if now - row.last_seen > NOT_CHECKING_IN_AFTER:
        return _evaluation(
            row, payload, is_self=False, checking_in=False, problems=[_not_checking_in(row, now)]
        )

    critical: list[Advisory] = []
    warning: list[Advisory] = []

    if row.schema_revision != head.schema_revision:
        critical.append(_schema_mismatch(row, head))
    if _has_name_conflict(payload, now):
        critical.append(_name_conflict(row))

    if row.schema_revision == head.schema_revision and not same_release(row.app_version, head.app_version):
        warning.append(_version_mismatch(row, head))
    if payload is not None:
        if row.mode == "agent" and payload.instance_name_source == "fallback":
            warning.append(_name_not_set(row))
        recent_start_count = sum(
            1 for started in payload.recent_starts if _within(now, started, RESTART_LOOP_WINDOW)
        )
        if recent_start_count >= RESTART_LOOP_STARTS:
            warning.append(_restart_loop(row, recent_start_count))
        ingestion_degraded = _ingestion_degraded(row, payload, head)
        if ingestion_degraded is not None:
            warning.append(ingestion_degraded)
    if payload is None:
        warning.append(_payload_unreadable(row, head))

    computed_ids = {problem.id for problem in critical + warning}
    forwarded_critical, forwarded_warning = _split_forwarded(payload)
    forwarded_critical = [advisory for advisory in forwarded_critical if advisory.id not in computed_ids]
    forwarded_warning = [advisory for advisory in forwarded_warning if advisory.id not in computed_ids]
    return _evaluation(
        row,
        payload,
        is_self=False,
        checking_in=True,
        problems=critical + forwarded_critical + warning + forwarded_warning,
    )


def _has_name_conflict(payload: HeartbeatPayload | None, now: datetime) -> bool:
    return (
        payload is not None
        and payload.name_conflict_at is not None
        and _within(now, payload.name_conflict_at, NAME_CONFLICT_SHOWN_FOR)
    )


def _split_forwarded(payload: HeartbeatPayload | None) -> tuple[list[Advisory], list[Advisory]]:
    if payload is None:
        return [], []
    critical: list[Advisory] = []
    warning: list[Advisory] = []
    for advisory in payload_advisories(payload):
        if advisory.id in DROPPED_FORWARDED_IDS:
            continue
        if advisory.severity == "critical":
            critical.append(_forwarded(advisory, "critical"))
        else:
            warning.append(_forwarded(advisory, "warning"))
    return critical, warning


def _forwarded_problems(payload: HeartbeatPayload | None) -> list[Advisory]:
    critical, warning = _split_forwarded(payload)
    return critical + warning


def _evaluation(
    row: HeartbeatRow,
    payload: HeartbeatPayload | None,
    *,
    is_self: bool,
    checking_in: bool,
    problems: list[Advisory],
) -> InstanceEvaluation:
    problems = _dedupe_by_id(problems)
    status: InstanceStatus = "ok"
    if any(problem.severity == "critical" for problem in problems):
        status = "critical"
    elif problems:
        status = "warning"
    return InstanceEvaluation(
        row=row,
        payload=payload,
        is_self=is_self,
        checking_in=checking_in,
        status=status,
        problems=problems,
    )


def _dedupe_by_id(problems: list[Advisory]) -> list[Advisory]:
    """Keep the first problem per id, so computed problems win over forwarded ones."""
    seen_ids: set[str] = set()
    unique: list[Advisory] = []
    for problem in problems:
        if problem.id not in seen_ids:
            seen_ids.add(problem.id)
            unique.append(problem)
    return unique


_STATUS_RANK: dict[InstanceStatus, int] = {"critical": 0, "warning": 1, "ok": 2}


def evaluate_instances(
    rows: list[HeartbeatRow], head: HeadIdentity, now: datetime
) -> list[InstanceEvaluation]:
    evaluations = [evaluate_instance(heartbeat_row, head, now) for heartbeat_row in rows]
    return sorted(
        evaluations,
        key=lambda evaluation: (
            not evaluation.is_self,
            _STATUS_RANK[evaluation.status],
            evaluation.row.instance_name,
        ),
    )
