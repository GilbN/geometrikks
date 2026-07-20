"""Typed shapes for CrowdSec LAPI responses."""
from __future__ import annotations

from dataclasses import dataclass


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
