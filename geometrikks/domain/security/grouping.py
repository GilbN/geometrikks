"""Collapses active decisions into one entry per target.

CrowdSec issues one decision per scenario, so an IP that trips three
scenarios holds three bans with three timers.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import reduce

from geometrikks.domain.security.map_data import decision_winner
from geometrikks.lib.validation import canonical_ip
from geometrikks.services.crowdsec import Decision

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


@dataclass
class DecisionGroup:
    """Every active decision against one target, longest-lived first."""

    scope: str
    value: str
    decisions: list[Decision] = field(default_factory=list)

    @property
    def type(self) -> str:
        return reduce(decision_winner, (decision.type for decision in self.decisions))

    @property
    def duration(self) -> str:
        """Time until the target is free of every decision."""
        return self.decisions[0].duration

    @property
    def origins(self) -> list[str]:
        return list(dict.fromkeys(decision.origin for decision in self.decisions))


def group_decisions(decisions: list[Decision]) -> list[DecisionGroup]:
    """One group per (scope, value), in the order the LAPI first listed them."""
    groups: dict[tuple[str, str], DecisionGroup] = {}
    for decision in decisions:
        value = decision.value
        if decision.scope == "Ip":
            value = canonical_ip(value) or value
        key = (decision.scope, value)
        if key not in groups:
            groups[key] = DecisionGroup(scope=decision.scope, value=value)
        groups[key].decisions.append(decision)
    for group in groups.values():
        group.decisions.sort(key=lambda d: go_duration_seconds(d.duration), reverse=True)
    return list(groups.values())
