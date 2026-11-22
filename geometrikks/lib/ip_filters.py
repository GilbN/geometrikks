"""IP include/exclude filters that take single addresses and CIDR ranges."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, cast

from advanced_alchemy.filters import (
    FilterTypes,
    ModelT,
    StatementFilter,
    StatementTypeT,
)
from sqlalchemy import ColumnElement, Select, and_, bindparam, not_, or_
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import InstrumentedAttribute

from geometrikks.domain.muted_ips.networks import (
    Network,
    normalize_network,
    with_mapped_twins,
)


@dataclass(frozen=True)
class IpMatch:
    """Parsed filter values: exact addresses and ranges, each IPv4 one with its IPv4-mapped twin."""

    addresses: tuple[str, ...]
    networks: tuple[Network, ...]


def parse_ip_filter(values: Iterable[str]) -> IpMatch:
    """Split filter values into addresses and ranges by the Muted IPs input rules.

    A /32 or /128 is the address it names. Every IPv4 value also matches its
    ``::ffff:`` form, as a muted entry does, since log rows may store either.

    Raises:
        DomainValidationError: If a value is not an address or a range starting on its network address.
        ValueError: If ``values`` is empty.
    """
    addresses: list[str] = []
    networks: list[Network] = []
    for network in with_mapped_twins(normalize_network(raw) for raw in values):
        if network.prefixlen == network.max_prefixlen:
            addresses.append(str(network.network_address))
        else:
            networks.append(network)
    if not addresses and not networks:
        raise ValueError("an IP filter needs at least one value")
    return IpMatch(tuple(dict.fromkeys(addresses)), tuple(dict.fromkeys(networks)))


def validate_ip_filter(values: Iterable[str] | None) -> None:
    """Reject a value that is not an address or a valid range before it reaches SQL."""
    if values:
        parse_ip_filter(values)


def ip_match_sql(column: str, values: Sequence[str], param: str) -> tuple[str, dict[str, Any]]:
    """``(column = ANY(addresses) OR column BETWEEN range bounds ...)`` with its bound params.

    Ranges are written as explicit bounds because Postgres only turns ``<<=``
    into a btree range scan when the right side is a literal: ``<<= ANY(array)``,
    or ``<<= $1`` under a generic prepared plan, scans every row. The bounds are
    exact only for host addresses (/32 and /128), which is all ingest stores.
    """
    match = parse_ip_filter(values)
    terms: list[str] = []
    params: dict[str, Any] = {}
    if match.addresses:
        terms.append(f"{column} = ANY(CAST(:{param} AS inet[]))")
        params[param] = list(match.addresses)
    for index, network in enumerate(match.networks):
        low, high = f"{param}_low_{index}", f"{param}_high_{index}"
        terms.append(f"({column} >= CAST(:{low} AS inet) AND {column} <= CAST(:{high} AS inet))")
        params[low] = str(network.network_address)
        params[high] = str(network.broadcast_address)
    if len(terms) == 1:
        return terms[0], params
    return "(" + " OR ".join(terms) + ")", params


def ip_match_clause(column: InstrumentedAttribute[Any], values: Sequence[str]) -> ColumnElement[bool]:
    """ORM form of :func:`ip_match_sql`."""
    match = parse_ip_filter(values)
    terms: list[ColumnElement[bool]] = []
    if match.addresses:
        terms.append(column.in_(match.addresses))
    for network in match.networks:
        terms.append(
            and_(
                column >= bindparam(None, str(network.network_address), type_=postgresql.INET, unique=True),
                column <= bindparam(None, str(network.broadcast_address), type_=postgresql.INET, unique=True),
            )
        )
    return terms[0] if len(terms) == 1 else or_(*terms)


@dataclass
class IpMatchFilter(StatementFilter):
    """Keep (or with ``exclude``, leave out) rows whose ``ip_address`` matches an address or range."""

    values: Sequence[str]
    exclude: bool = False

    def append_to_statement(self, statement: StatementTypeT, model: type[ModelT]) -> StatementTypeT:
        if not isinstance(statement, Select):
            return statement
        column = cast("InstrumentedAttribute[Any]", getattr(model, "ip_address"))  # noqa: B009
        clause = ip_match_clause(column, self.values)
        return statement.where(not_(clause) if self.exclude else clause)  # type: ignore[return-value]


def ip_match_filter(values: Sequence[str], *, exclude: bool = False) -> FilterTypes:
    """An :class:`IpMatchFilter` typed for advanced-alchemy's filter lists, whose union it is not part of."""
    return cast("FilterTypes", IpMatchFilter(values, exclude))
