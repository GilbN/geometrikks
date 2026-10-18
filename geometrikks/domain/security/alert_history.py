"""Cursor paging over the LAPI alert history.

GET /v1/alerts has no offset: it answers the newest ``limit`` alerts, ordered
by ``created_at`` then ``id``, both descending. A page further back asks for
alerts created before the cursor with ``created_before``, a duration the LAPI
counts back from its own clock, then drops what is not strictly older than
the cursor.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from geometrikks.domain.exceptions import DomainConflictError, DomainValidationError
from geometrikks.server.logging import get_logger
from geometrikks.services.crowdsec import Alert, CrowdSecService

logger = get_logger(__name__)

# The LAPI clock can run ahead of or behind ours, and created_before only has
# whole-second precision. Asking for a few minutes more than the cursor's age
# keeps the cursor's own second inside the answer; the extra rows newer than
# the cursor are dropped here.
CURSOR_MARGIN = timedelta(minutes=5)
# Ceiling on one LAPI request while growing the fetch past newer rows.
MAX_FETCH = 2000

FLOOD_CONFLICT = "Too many alerts at the same moment to page past; filter by IP or scenario."


@dataclass(frozen=True, slots=True)
class AlertCursor:
    created_at: datetime
    id: int


@dataclass(frozen=True, slots=True)
class AlertFilters:
    ip: str | None = None
    scenario: str | None = None
    since: str | None = None
    kind: str | None = None
    has_active_decision: bool | None = None


@dataclass(frozen=True, slots=True)
class AlertPage:
    alerts: list[Alert]
    next_cursor: str | None


def _created_at(alert: Alert) -> datetime:
    created_at = datetime.fromisoformat(alert.created_at)
    return created_at if created_at.tzinfo is not None else created_at.replace(tzinfo=UTC)


def _sort_key(alert: Alert) -> tuple[datetime, int]:
    return _created_at(alert), alert.id or 0


def encode_cursor(alert: Alert) -> str:
    created_at, alert_id = _sort_key(alert)
    raw = f"{int(created_at.timestamp())}:{alert_id}".encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def decode_cursor(raw: str) -> AlertCursor:
    try:
        padded = raw + "=" * (-len(raw) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("ascii")
        timestamp, alert_id = decoded.split(":")
        return AlertCursor(
            created_at=datetime.fromtimestamp(int(timestamp), tz=UTC), id=int(alert_id)
        )
    except (ValueError, UnicodeError, binascii.Error, OverflowError, OSError):
        raise DomainValidationError("Invalid alert cursor") from None


def _created_before(cursor: AlertCursor, now: datetime, margin: timedelta) -> str | None:
    age_seconds = int((now - cursor.created_at - margin).total_seconds())
    return f"{age_seconds}s" if age_seconds > 0 else None


async def _fetch_source(
    service: CrowdSecService,
    lapi_filters: dict[str, Any],
    *,
    limit: int,
    before: AlertCursor | None,
    now: datetime,
) -> tuple[list[Alert], bool]:
    """Alerts older than ``before`` from one LAPI query, and whether the LAPI
    answer was full (so more may follow)."""
    fetch_limit = limit
    margin = CURSOR_MARGIN
    while True:
        created_before = None if before is None else _created_before(before, now, margin)
        alerts = await service.get_alerts(
            limit=fetch_limit, created_before=created_before, **lapi_filters
        )
        full = len(alerts) == fetch_limit
        if before is None:
            return alerts, full
        cursor_key = (before.created_at, before.id)
        older = [alert for alert in alerts if _sort_key(alert) < cursor_key]
        if not full or len(older) >= limit:
            return older, full
        if fetch_limit < MAX_FETCH:
            fetch_limit = min(fetch_limit * 4, MAX_FETCH)
            continue
        if margin:
            # Without the margin a LAPI clock running behind ours can skip
            # alerts from the cursor's last seconds; better than no page.
            logger.info("alert_page_margin_dropped", fetch_limit=fetch_limit, **lapi_filters)
            margin = timedelta(0)
            continue
        if older:
            return older, full
        logger.warning("alert_page_flood_conflict", fetch_limit=fetch_limit, **lapi_filters)
        raise DomainConflictError(FLOOD_CONFLICT)


async def fetch_alert_page(
    service: CrowdSecService,
    filters: AlertFilters,
    *,
    limit: int,
    before: AlertCursor | None,
    now: datetime | None = None,
) -> AlertPage:
    """One page of alerts, newest first, older than ``before`` when given.

    Raises:
        DomainConflictError: More than ``MAX_FETCH`` alerts share the cursor's
            second, so no request can reach past them.
    """
    lapi_filters: dict[str, Any] = {
        "ip": filters.ip,
        "scenario": filters.scenario,
        "since": filters.since,
        "kind": filters.kind,
        "has_active_decision": filters.has_active_decision,
    }
    alerts, full = await _fetch_source(
        service, lapi_filters, limit=limit, before=before, now=now or datetime.now(UTC)
    )
    page_alerts = alerts[:limit]
    more = full or len(alerts) > limit
    return AlertPage(
        alerts=page_alerts,
        next_cursor=encode_cursor(page_alerts[-1]) if more and page_alerts else None,
    )
