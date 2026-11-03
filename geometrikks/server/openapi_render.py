"""Serves /schema/openapi.json with the example time range set to the last 24 hours."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from litestar.openapi.plugins import JsonRenderPlugin

from geometrikks.lib.parameters import EXAMPLE_RANGE_END, EXAMPLE_RANGE_START

if TYPE_CHECKING:
    from collections.abc import Callable

    from litestar import Request

_EXAMPLE_RANGE = re.compile(f"{re.escape(EXAMPLE_RANGE_START)}|{re.escape(EXAMPLE_RANGE_END)}".encode())


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _iso_minute(moment: datetime) -> bytes:
    return moment.strftime("%Y-%m-%dT%H:%M:00Z").encode()


class LiveRangeExamplesJsonPlugin(JsonRenderPlugin):
    """The OpenAPI JSON route, with the fixed example range swapped for the last 24 hours.

    The committed schema and the generated client keep the fixed dates, so typegen output stays
    the same from day to day. Scalar prefills Test Request from these examples, so the reference
    always offers a range that holds recent data.
    """

    def __init__(self, *, clock: Callable[[], datetime] = _utc_now, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.clock = clock

    def render(self, request: Request, openapi_schema: dict[str, Any]) -> bytes:
        rendered = super().render(request, openapi_schema)
        range_end = self.clock().astimezone(UTC).replace(second=0, microsecond=0)
        replacements = {
            EXAMPLE_RANGE_START.encode(): _iso_minute(range_end - timedelta(days=1)),
            EXAMPLE_RANGE_END.encode(): _iso_minute(range_end),
        }
        # One pass, so a start date that happens to equal the end example is not replaced twice.
        return _EXAMPLE_RANGE.sub(lambda match: replacements[match.group(0)], rendered)
