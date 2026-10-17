"""Turn heartbeat rows into a status and a list of problems per instance.

Pure: the caller passes the head's identity and the current time, and nothing
here reads a clock or touches the database. The API and the scheduled check
both call it so the rules live in one place.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal, Self
from uuid import UUID

from geometrikks.domain.instances.models import InstanceHeartbeat
from geometrikks.domain.instances.schemas import (
    ForwardedAdvisory,
    HeartbeatPayload,
    decode_payload,
    payload_advisories,
)
from geometrikks.lib.advisories import Advisory

NOT_CHECKING_IN_AFTER = timedelta(seconds=180)
NAME_CONFLICT_SHOWN_FOR = timedelta(minutes=5)
RESTART_LOOP_STARTS = 3
RESTART_LOOP_WINDOW = timedelta(hours=1)

DROPPED_FORWARDED_IDS = frozenset({"proxy-peer-cdn"})

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


def _age_text(age: timedelta) -> str:
    minutes = int(age.total_seconds() // 60)
    if minutes < 60:
        return f"{minutes} minutes ago"
    hours = minutes // 60
    if hours < 48:
        return "1 hour ago" if hours == 1 else f"{hours} hours ago"
    return f"{hours // 24} days ago"


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
        f"Agent {row.instance_name} runs v{row.app_version} on migration {row.schema_revision}; "
        f"the head runs v{head.app_version} on migration {head.schema_revision}."
    )
    if row.schema_revision in head.known_revisions:
        return Advisory(
            id="instance-schema-behind",
            severity="critical",
            summary=versions,
            detail=(
                f"{row.instance_name} expects an older database schema than the "
                "one the head applied, so its writes can fail."
            ),
            remedy=f"Upgrade {row.instance_name} to v{head.app_version}.",
        )
    return Advisory(
        id="instance-schema-ahead",
        severity="critical",
        summary=versions,
        detail=(
            f"{row.instance_name} runs a newer schema than the head knows. The "
            "head cannot read everything it writes."
        ),
        remedy=f"Upgrade the head to v{row.app_version} or later.",
    )


def _name_conflict(row: HeartbeatRow) -> Advisory:
    return Advisory(
        id="instance-name-conflict",
        severity="critical",
        summary=f"More than one process is using the name {row.instance_name}.",
        detail=(
            "Two processes keep overwriting each other's heartbeat, so this "
            "row shows only one of them and the other is invisible."
        ),
        remedy="Give each agent its own APP_INSTANCE_NAME.",
    )


def _version_mismatch(row: HeartbeatRow, head: HeadIdentity) -> Advisory:
    return Advisory(
        id="instance-version-mismatch",
        severity="warning",
        summary=(
            f"Agent {row.instance_name} runs v{row.app_version}; the head runs "
            f"v{head.app_version}. Both are on migration {head.schema_revision}."
        ),
        detail="The database schema matches, but the code differs, so behavior can drift.",
        remedy=f"Upgrade {row.instance_name} to v{head.app_version}.",
    )


def _name_not_set(row: HeartbeatRow) -> Advisory:
    return Advisory(
        id="instance-name-not-set",
        severity="warning",
        summary=f"Agent {row.instance_name} is running under the default name.",
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


def _payload_unreadable(row: HeartbeatRow, head: HeadIdentity) -> Advisory:
    return Advisory(
        id="instance-payload-unreadable",
        severity="warning",
        summary=f"The health report from {row.instance_name} could not be read.",
        detail=(
            "The version, migration and last seen time are still shown. "
            f"{row.instance_name} runs v{row.app_version}; the head runs v{head.app_version}."
        ),
        remedy="Check that both run compatible versions.",
    )


def evaluate_instance(row: HeartbeatRow, head: HeadIdentity, now: datetime) -> InstanceEvaluation:
    is_self = row.boot_id == head.boot_id
    payload = decode_payload(row.payload)

    if is_self:
        forwarded_problems = _forwarded_problems(payload)
        return _evaluation(row, payload, True, True, forwarded_problems)

    if now - row.last_seen > NOT_CHECKING_IN_AFTER:
        return _evaluation(row, payload, False, False, [_not_checking_in(row, now)])

    critical: list[Advisory] = []
    warning: list[Advisory] = []

    if row.schema_revision != head.schema_revision:
        critical.append(_schema_mismatch(row, head))
    if payload is not None and payload.name_conflict_at is not None:
        if now - payload.name_conflict_at <= NAME_CONFLICT_SHOWN_FOR:
            critical.append(_name_conflict(row))
    forwarded_critical, forwarded_warning = _split_forwarded(payload)
    critical.extend(forwarded_critical)

    if row.schema_revision == head.schema_revision and row.app_version != head.app_version:
        warning.append(_version_mismatch(row, head))
    if payload is not None:
        if row.mode == "agent" and payload.instance_name_source == "fallback":
            warning.append(_name_not_set(row))
        recent_start_count = sum(
            1 for started in payload.recent_starts if now - started <= RESTART_LOOP_WINDOW
        )
        if recent_start_count >= RESTART_LOOP_STARTS:
            warning.append(_restart_loop(row, recent_start_count))
    warning.extend(forwarded_warning)
    if payload is None:
        warning.append(_payload_unreadable(row, head))

    return _evaluation(row, payload, False, True, critical + warning)


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
    is_self: bool,
    checking_in: bool,
    problems: list[Advisory],
) -> InstanceEvaluation:
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
