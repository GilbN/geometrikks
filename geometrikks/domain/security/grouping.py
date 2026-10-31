"""Collapses active decisions into one entry per target.

CrowdSec issues one decision per scenario, so an IP that trips three
scenarios holds three bans with three timers.
"""
from __future__ import annotations

import ipaddress
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


IpNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network


# An address, then optionally a prefix length without leading zeros. Narrower
# than ip_network on purpose: the frontend's isValidBanTarget decides when to
# say "every origin", so netmask forms, zone ids and /0 stay text here too.
_SEARCH_CIDR = re.compile(r"([^/%\s]+)(?:/([1-9][0-9]{0,2}))?")


def search_network(query: str) -> IpNetwork | None:
    """The IP or CIDR a decisions search names, or None for any other text.

    A bare IP is a /32 (or /128), so one test covers both. An IPv4-mapped
    IPv6 address, as a dual-stack proxy logs it, searches as its IPv4 form.
    """
    match = _SEARCH_CIDR.fullmatch(query.strip())
    if match is None:
        return None
    try:
        address = ipaddress.ip_address(match[1])
    except ValueError:
        return None
    prefix = int(match[2]) if match[2] else address.max_prefixlen
    if prefix > address.max_prefixlen:
        return None
    network = _unmapped(ipaddress.ip_network(f"{address}/{prefix}", strict=False))
    # ::ffff:0:0/96 is 0.0.0.0/0 under another name.
    return network if network.prefixlen > 0 else None


def _unmapped(network: IpNetwork) -> IpNetwork:
    """An IPv4-mapped IPv6 network (::ffff:a.b.c.d/96 and narrower) as IPv4,
    so it compares with IPv4 decisions whichever side carries the mapping."""
    if isinstance(network, ipaddress.IPv6Network) and network.prefixlen >= 96:
        mapped = network.network_address.ipv4_mapped
        if mapped is not None:
            return ipaddress.IPv4Network(f"{mapped}/{network.prefixlen - 96}")
    return network


def _group_in_network(group: DecisionGroup, network: IpNetwork) -> bool:
    if group.scope not in ("Ip", "Range"):
        return False
    try:
        target = ipaddress.ip_network(group.value, strict=False)
    except ValueError:
        return False
    # A Range decision covers the searched IP; a searched CIDR covers IP
    # decisions. A mapped target is compared both as stored, for IPv6
    # searches, and unmapped, for IPv4 ones.
    return any(
        candidate.version == network.version and candidate.overlaps(network)
        for candidate in (target, _unmapped(target))
    )


def search_groups(groups: list[DecisionGroup], query: str) -> list[DecisionGroup]:
    """Groups that match a decisions search, in their original order.

    An IP or CIDR matches decisions on addresses inside it and ranges that
    hold it. Any other text matches the start of the target value or any
    part of a scenario name, ignoring case.
    """
    network = search_network(query)
    if network is not None:
        return [group for group in groups if _group_in_network(group, network)]
    text = query.strip().casefold()
    if not text:
        return groups
    return [
        group
        for group in groups
        if group.value.casefold().startswith(text)
        or any(text in decision.scenario.casefold() for decision in group.decisions)
    ]
