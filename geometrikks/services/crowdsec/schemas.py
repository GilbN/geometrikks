"""Typed shapes for CrowdSec LAPI responses."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_GO_UNIT_SECONDS = {"h": 3600.0, "m": 60.0, "s": 1.0, "ms": 1e-3, "us": 1e-6, "µs": 1e-6, "ns": 1e-9}
_GO_DURATION_PART = re.compile(r"(\d+(?:\.\d+)?)(h|ms|us|µs|ns|m|s)")


def go_duration_seconds(duration: str) -> float:
    """Seconds in a Go duration such as ``1h49m36s``; 0 when it does not parse.

    The LAPI sends the time left as a duration only, never as a timestamp.
    """
    sign = -1.0 if duration.startswith("-") else 1.0
    body = duration.lstrip("+-")
    parts = _GO_DURATION_PART.findall(body)
    if not parts or "".join(amount + unit for amount, unit in parts) != body:
        return 0.0
    return sign * sum(float(amount) * _GO_UNIT_SECONDS[unit] for amount, unit in parts)


def go_duration(seconds: int) -> str:
    """Whole seconds as the LAPI spells a duration, such as ``1h0m5s``."""
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}h{minutes}m{secs}s"
    if minutes:
        return f"{minutes}m{secs}s"
    return f"{secs}s"


@dataclass
class DecisionStreamDelta:
    """One page of the LAPI decision stream: decisions added and expired."""

    new: list[Decision]
    deleted: list[Decision]


@dataclass
class Decision:
    """One active LAPI decision.

    ``value`` is an IP only when ``scope`` is ``Ip``; Range/Country/AS
    decisions carry a CIDR, country code, or AS number instead.
    """

    id: int | None
    origin: str
    type: str
    scope: str
    value: str
    duration: str
    scenario: str
    simulated: bool | None = None

    @property
    def expired(self) -> bool:
        """Alerts keep decisions past their expiry, with a negative duration."""
        return self.duration.startswith("-")


@dataclass
class AlertSource:
    """The offending source an alert was raised against."""

    scope: str
    value: str
    ip: str | None = None
    cn: str | None = None  # LAPI's own country enrichment (ISO alpha-2)
    as_name: str | None = None
    as_number: str | None = None
    range: str | None = None


@dataclass
class AlertContext:
    """One alert-context key with the distinct values seen across the bucket."""

    key: str
    values: list[str]


@dataclass
class AlertEvent:
    """One stored event. The LAPI keeps a capped sample of an alert's events."""

    timestamp: str
    meta: dict[str, str]


@dataclass
class Alert:
    """One LAPI alert: a scenario that fired, with its resulting decisions."""

    id: int | None
    scenario: str
    message: str
    events_count: int
    created_at: str
    source: AlertSource
    machine_id: str | None = None
    kind: str | None = None
    simulated: bool | None = None
    start_at: str | None = None
    stop_at: str | None = None
    decisions: list[Decision] = field(default_factory=list)
    context: list[AlertContext] = field(default_factory=list)
    events: list[AlertEvent] = field(default_factory=list)
