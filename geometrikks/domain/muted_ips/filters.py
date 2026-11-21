"""Statement filter that hides muted networks from a repository list query."""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from ipaddress import IPv4Network, IPv6Network
from typing import Any, cast

from advanced_alchemy.filters import ModelT, StatementFilter, StatementTypeT
from sqlalchemy import Select, any_, bindparam, not_
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import InstrumentedAttribute


@dataclass
class MutedNetworksFilter(StatementFilter):
    """``NOT (ip_address <<= ANY(networks))``; ``ip_address`` is NOT NULL on the models that use it."""

    networks: Sequence[IPv4Network | IPv6Network]

    def append_to_statement(self, statement: StatementTypeT, model: type[ModelT]) -> StatementTypeT:
        if not isinstance(statement, Select):
            return statement
        networks = bindparam(
            "muted_networks", value=list(self.networks), type_=postgresql.ARRAY(postgresql.CIDR), unique=True
        )
        column = cast("InstrumentedAttribute[Any]", getattr(model, "ip_address"))  # noqa: B009
        return statement.where(not_(column.op("<<=")(any_(networks))))  # type: ignore[return-value]
