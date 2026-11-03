"""Wire shape of the heartbeat payload stored in instance_heartbeats.payload.

Every field, nested ones included, has a default so a row written by an older
or newer release still decodes. Keys are only ever added, never renamed or
repurposed.
"""
from datetime import datetime
from typing import Annotated, Any

import msgspec

ERROR_MESSAGE_MAX_CHARS = 500


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
    """A log source the instance tails."""

    kind: Annotated[str, msgspec.Meta(description="`file` or `loki`.")] = ""
    label: Annotated[str, msgspec.Meta(description="The file path, or the LogQL query of a Loki source.")] = ""
    server_name: Annotated[str, msgspec.Meta(description="The server name its log lines are recorded under.")] = ""
    log_format: Annotated[
        str | None, msgspec.Meta(description="The parser's log format, such as `traefik-json`. Null until it is known.")
    ] = None
    available: bool = True
    reason: Annotated[str | None, msgspec.Meta(description="Why the source is unavailable, when it is.")] = None
    parsed_lines: Annotated[int, msgspec.Meta(description="Lines parsed from this source since the instance started.")] = 0


class JobReport(msgspec.Struct, rename="camel", kw_only=True):
    """A scheduler job on the instance."""

    id: str = ""
    name: str = ""
    next_run_time: datetime | None = None
    last_start: datetime | None = None
    last_status: Annotated[str | None, msgspec.Meta(description="`success`, `error` or `missed`.")] = None
    last_error: Annotated[
        str | None, msgspec.Meta(description=f"The error of the last run, cut to {ERROR_MESSAGE_MAX_CHARS} characters.")
    ] = None


class LastErrorReport(msgspec.Struct, rename="camel", kw_only=True):
    """The last failed database write on the instance."""

    message: str = ""
    at: datetime | None = None


class HeartbeatPayload(msgspec.Struct, rename="camel", kw_only=True):
    """The details an instance sends with each heartbeat.

    The 5-minute counts are null until the instance has run for 5 minutes.
    """

    health: Annotated[
        dict[str, Any],
        msgspec.Meta(description="The instance's health report as raw JSON. The instance's `health` field holds the same report with a schema."),
    ] = {}
    jobs: list[JobReport] = []
    last_error: LastErrorReport | None = None
    lines_5m: Annotated[int | None, msgspec.Meta(description="Log lines parsed in the last 5 minutes.")] = None
    failed_5m: Annotated[int | None, msgspec.Meta(description="Records that failed to write in the last 5 minutes.")] = None
    written_5m: Annotated[int | None, msgspec.Meta(description="Records written in the last 5 minutes.")] = None
    failed_batches_5m: Annotated[
        int | None, msgspec.Meta(description="Database writes that failed in the last 5 minutes.")
    ] = None
    recent_starts: Annotated[
        list[datetime], msgspec.Meta(description="When the process started, for up to its last 10 starts.")
    ] = []
    name_conflict_at: Annotated[
        datetime | None,
        msgspec.Meta(description="When another process last sent heartbeats under the same instance name."),
    ] = None
    server_names: Annotated[
        list[str], msgspec.Meta(description="The server names the instance records log lines under.")
    ] = []
    sources: list[SourceReport] = []
    instance_name_source: Annotated[
        str,
        msgspec.Meta(description="`configured` when APP_INSTANCE_NAME is set, `fallback` when the name is the default."),
    ] = "fallback"


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
