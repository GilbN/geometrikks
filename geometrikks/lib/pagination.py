"""Paging and sorting providers for the paged list endpoints.

advanced_alchemy's create_service_dependencies gives ``pageSize`` no upper
bound and passes ``orderBy`` straight to a model attribute lookup, so an
unknown field answers 500. A controller keeps ``pagination_type`` and
``sort_field`` in its filter config and replaces the providers under
LIMIT_OFFSET_KEY and ORDER_BY_KEY with these. The aggregate ``filters``
dependency only asks for keys advanced_alchemy built itself, so dropping the
config entries drops the filters too.
"""

# This module skips ``from __future__ import annotations``. The parameter
# annotations close over each call's arguments, and Litestar cannot resolve
# those names from a string annotation.

from collections.abc import Sequence
from typing import Annotated, Literal

from advanced_alchemy.extensions.litestar.providers import DEPENDENCY_DEFAULTS
from advanced_alchemy.filters import LimitOffset, OrderBy
from litestar.di import Provide
from litestar.params import QueryParameter

from geometrikks.domain.exceptions import DomainValidationError

LIMIT_OFFSET_KEY = DEPENDENCY_DEFAULTS.LIMIT_OFFSET_FILTER_DEPENDENCY_KEY
ORDER_BY_KEY = DEPENDENCY_DEFAULTS.ORDER_BY_FILTER_DEPENDENCY_KEY

MAX_PAGE_SIZE = 500
# The Access Logs and Debug Logs pages offer 1000 rows a page.
MAX_LOG_PAGE_SIZE = 1000


def limit_offset_provider(*, default_size: int, max_size: int = MAX_PAGE_SIZE) -> Provide:
    """``currentPage`` and ``pageSize`` with ``pageSize`` capped at ``max_size``."""

    def provide_limit_offset(
        current_page: Annotated[
            int,
            QueryParameter(
                name="currentPage",
                ge=1,
                required=False,
                description="The page to return, counted from 1. Defaults to 1.",
            ),
        ] = 1,
        page_size: Annotated[
            int,
            QueryParameter(
                name="pageSize",
                ge=1,
                le=max_size,
                required=False,
                description=f"Rows per page, from 1 to {max_size}. Defaults to {default_size}.",
            ),
        ] = default_size,
    ) -> LimitOffset:
        return LimitOffset(page_size, page_size * (current_page - 1))

    return Provide(provide_limit_offset, sync_to_thread=False)


def order_by_provider(*, fields: Sequence[str], default: str, note: str = "") -> Provide:
    """``orderBy`` limited to ``fields``, and ``sortOrder``. Any other field is a 400."""
    allowed = frozenset(fields)
    listed = ", ".join(f"`{field}`" for field in fields)
    order_by_description = (
        f"The field to sort by, one of {listed}. Defaults to `{default}`, and any other value gets a 400. {note}"
    ).strip()

    def provide_order_by(
        field_name: Annotated[
            str,
            QueryParameter(name="orderBy", required=False, description=order_by_description),
        ] = default,
        sort_order: Annotated[
            Literal["asc", "desc"],
            QueryParameter(name="sortOrder", required=False, description="`asc` or `desc`. Defaults to `desc`."),
        ] = "desc",
    ) -> OrderBy:
        if field_name not in allowed:
            raise DomainValidationError(f"Cannot sort by {field_name!r}")
        return OrderBy(field_name=field_name, sort_order=sort_order)

    return Provide(provide_order_by, sync_to_thread=False)
