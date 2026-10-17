"""Wire shape of the heartbeat payload stored in instance_heartbeats.payload.

Every field has a default so a row written by an older or newer release still
decodes. Keys are only ever added, never renamed or repurposed.
"""
from datetime import datetime
from typing import Any

import msgspec


class ForwardedAdvisory(msgspec.Struct, rename="camel", kw_only=True):
    """An advisory an instance reported about itself.

    severity is a plain str so a value from a newer release does not make the
    whole heartbeat undecodable. The evaluator maps unknown values later.
    """

    id: str
    severity: str = "warning"
    summary: str = ""
    detail: str | None = None
    remedy: str | None = None
    docs_url: str | None = None


class SourceReport(msgspec.Struct, rename="camel", kw_only=True):
    kind: str
    label: str
    server_name: str
    log_format: str | None = None
    available: bool = True
    reason: str | None = None
    parsed_lines: int = 0


class JobReport(msgspec.Struct, rename="camel", kw_only=True):
    id: str
    name: str
    next_run_time: datetime | None = None
    last_start: datetime | None = None
    last_status: str | None = None
    last_error: str | None = None


class LastErrorReport(msgspec.Struct, rename="camel", kw_only=True):
    message: str
    at: datetime


class HeartbeatPayload(msgspec.Struct, rename="camel", kw_only=True):
    health: dict[str, Any] = {}
    jobs: list[JobReport] = []
    last_error: LastErrorReport | None = None
    lines_5m: int | None = None
    failed_5m: int | None = None
    recent_starts: list[datetime] = []
    name_conflict_at: datetime | None = None
    server_names: list[str] = []
    sources: list[SourceReport] = []
    instance_name_source: str = "fallback"


def decode_payload(raw: dict[str, Any]) -> HeartbeatPayload | None:
    """Decode a stored payload; None when it does not fit the schema."""
    try:
        return msgspec.convert(raw, HeartbeatPayload, strict=False)
    except msgspec.ValidationError:
        return None


def payload_advisories(payload: HeartbeatPayload) -> list[ForwardedAdvisory]:
    """The advisories inside payload.health, skipping malformed entries."""
    raw_advisories = payload.health.get("advisories")
    if not isinstance(raw_advisories, list):
        return []
    advisories: list[ForwardedAdvisory] = []
    for raw_advisory in raw_advisories:
        try:
            advisories.append(
                msgspec.convert(raw_advisory, ForwardedAdvisory, strict=False)
            )
        except msgspec.ValidationError:
            continue
    return advisories
