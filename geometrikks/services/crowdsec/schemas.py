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


@dataclass
class AlertSource:
    """The offending source an alert was raised against."""

    scope: str
    value: str
    ip: str | None = None
    cn: str | None = None  # LAPI's own country enrichment (ISO alpha-2)
    as_name: str | None = None


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
    decisions: list[Decision] = field(default_factory=list)
