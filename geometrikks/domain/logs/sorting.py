"""Sort helpers for the access-log list.

advanced-alchemy's OrderBy emits a bare ASC/DESC. Postgres puts NULLs first
on DESC, so a "slowest first" sort on the nullable timing columns would lead
with the rows that have no timing at all.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast

from advanced_alchemy.filters import FilterTypes, ModelT, OrderBy, StatementFilter, StatementTypeT
from sqlalchemy import Select

TIMING_SORT_FIELDS: frozenset[str] = frozenset({"request_time", "upstream_response_time"})


@dataclass
class NullsLastOrderBy(StatementFilter):
    """ORDER BY <field> <dir> NULLS LAST."""

    field_name: str
    sort_order: Literal["asc", "desc"] = "asc"

    def append_to_statement(self, statement: StatementTypeT, model: type[ModelT]) -> StatementTypeT:
        if not isinstance(statement, Select):
            return statement
        column = getattr(model, self.field_name)
        direction = column.desc() if self.sort_order == "desc" else column.asc()
        return statement.order_by(direction.nulls_last())  # type: ignore[return-value]


def nulls_last_for_timings(filters: list[FilterTypes]) -> list[FilterTypes]:
    """Swap OrderBy on a timing column for the NULLS LAST variant."""
    return cast(
        list[FilterTypes],
        [
            NullsLastOrderBy(f.field_name, f.sort_order)  # type: ignore[arg-type]
            if isinstance(f, OrderBy) and isinstance(f.field_name, str) and f.field_name in TIMING_SORT_FIELDS
            else f
            for f in filters
        ],
    )
