"""Alerts per calendar day, by when each alert's first event happened."""

from __future__ import annotations

import math
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from geometrikks.services.crowdsec import Alert

# The LAPI applies ``since`` to its own clock when the request lands. Asking
# for a few minutes more keeps the first midnight inside the answer while the
# clocks agree to within the margin; count_by_day drops the extra alerts.
SINCE_MARGIN = timedelta(minutes=5)


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def day_window(now: datetime, zone: ZoneInfo, days: int) -> tuple[list[date], datetime]:
    """The ``days`` local dates ending today, and the midnight the first one starts at."""
    today = now.astimezone(zone).date()
    dates = [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]
    return dates, datetime.combine(dates[0], time.min, tzinfo=zone)


def since_duration(now: datetime, start: datetime) -> str:
    """How far back ``start`` lies, plus SINCE_MARGIN, as the Go duration the LAPI's ``since`` takes."""
    back = now.astimezone(UTC) - start.astimezone(UTC) + SINCE_MARGIN
    return f"{math.ceil(back.total_seconds())}s"


def count_by_day(alerts: list[Alert], dates: list[date], zone: ZoneInfo) -> list[int]:
    """Alerts per date, by ``start_at``, or ``created_at`` when that is missing.

    An alert dated before the window is left out. One dated after it, from a
    machine whose clock runs ahead, counts on the last day.
    """
    counts = dict.fromkeys(dates, 0)
    # The LAPI pages its answer by offset, so an alert stored mid-request can
    # push a row into the next page and send it twice.
    seen: set[int] = set()
    for alert in alerts:
        if alert.id is not None:
            if alert.id in seen:
                continue
            seen.add(alert.id)
        started = _parse(alert.start_at) or _parse(alert.created_at)
        if started is None:
            continue
        day = min(started.astimezone(zone).date(), dates[-1])
        if day in counts:
            counts[day] += 1
    return [counts[day] for day in dates]
