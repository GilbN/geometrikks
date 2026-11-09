"""Shared relative windows and explicit analytics ranges."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated

from litestar.params import QueryParameter

from geometrikks.domain.exceptions import DomainValidationError
from geometrikks.lib.parameters import (
    RANGE_END_DESCRIPTION, RANGE_START_DESCRIPTION, range_end_examples, range_start_examples,
)

MAX_WINDOW = timedelta(days=365)
WINDOW_DESCRIPTION = (
    "A rolling window ending now, such as `15m`, `24h` or `7d`, up to 365 days. "
    "Use positive whole minutes, hours or days. Cannot be combined with explicit time bounds."
)
Window = Annotated[str | None, QueryParameter(required=False, description=WINDOW_DESCRIPTION)]


@dataclass(frozen=True)
class TimeRange:
    """Inclusive start and exclusive end, both with a timezone."""

    start: datetime
    end: datetime


def relative_range(window: str, *, now: datetime | None = None) -> TimeRange:
    """Resolve a bounded rolling window using one reading of the clock."""
    if not re.fullmatch(r"[1-9][0-9]{0,5}[mhd]", window):
        raise DomainValidationError(
            "Use a positive whole number followed by m, h or d for window.", code="invalid_range",
        )
    seconds = int(window[:-1]) * {"m": 60, "h": 3600, "d": 86400}[window[-1]]
    if seconds > MAX_WINDOW.total_seconds():
        raise DomainValidationError("window cannot exceed 365 days.", code="invalid_range")
    end = now if now is not None else datetime.now(UTC)
    return TimeRange(end - timedelta(seconds=seconds), end)


def provide_time_range(
    start_date: Annotated[
        datetime | None,
        QueryParameter(
            name="startDate", required=False, examples=range_start_examples(),
            description=f"{RANGE_START_DESCRIPTION} Requires endDate; omit with window.",
        ),
    ] = None,
    end_date: Annotated[
        datetime | None,
        QueryParameter(
            name="endDate", required=False, examples=range_end_examples(),
            description=f"{RANGE_END_DESCRIPTION} Requires startDate; omit with window.",
        ),
    ] = None,
    window: Window = None,
) -> TimeRange:
    """Accept either a window or two ordered, timezone-aware bounds."""
    if window is not None:
        if start_date is not None or end_date is not None:
            raise DomainValidationError("Use window or startDate and endDate, not both.", code="invalid_range")
        return relative_range(window)
    if start_date is None or end_date is None:
        raise DomainValidationError("Supply window or both startDate and endDate.", code="invalid_range")
    if start_date.utcoffset() is None or end_date.utcoffset() is None or start_date >= end_date:
        raise DomainValidationError(
            "startDate must precede endDate and both must include a timezone.", code="invalid_range",
        )
    return TimeRange(start_date, end_date)
