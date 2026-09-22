"""Typed shapes for CrowdSec LAPI responses."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class DecisionStreamDelta:
    """One page of the LAPI decision stream: decisions added and expired."""

    new: list["Decision"]
    deleted: list["Decision"]


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
