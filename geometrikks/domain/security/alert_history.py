"""Cursor paging over the LAPI alert history.

GET /v1/alerts has no offset: it answers the newest ``limit`` alerts, ordered
by ``created_at`` then ``id``, both descending. A page further back asks for
alerts created before the cursor with ``created_before``, a duration the LAPI
counts back from its own clock, then drops what is not strictly older than
the cursor. When that answer holds neither the cursor alert nor one from a
later second, the cutoff may have stopped short of the cursor and cut alerts
out, so the page is fetched again without ``created_before``, past every
newer alert. More than ``MAX_FETCH`` alerts inside the margin get one more
request with a cutoff one second past the cursor's age, which keeps the
cursor's whole second inside the answer while the clocks agree; a flood
that request cannot get past is a conflict.

The bot group runs three LAPI queries side by side, and an IP filter
doubles every query. They share the LAPI clock and send the same
``created_before`` on each pass, so an answer from any of them that reaches
the cursor proves the cutoff for all of them.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from geometrikks.domain.exceptions import DomainConflictError, DomainValidationError
from geometrikks.lib.validation import canonical_ip
from geometrikks.server.logging import get_logger
from geometrikks.services.crowdsec import Alert, CrowdSecService

logger = get_logger(__name__)

# The LAPI clock can run ahead of or behind ours, and created_before only has
# whole-second precision. Asking for a few minutes more than the cursor's age
# keeps the cursor's own second inside the answer while the clocks agree to
# within the margin; the extra rows newer than the cursor are dropped here.
CURSOR_MARGIN = timedelta(minutes=5)
# created_before has whole-second precision while the LAPI applies it to
# sub-second created_at. One second toward the present keeps the cursor's
# whole second inside the exact-age answer while the clocks agree.
EXACT_AGE_SLACK = timedelta(seconds=1)
# Ceiling on one LAPI request while growing the fetch past newer rows.
MAX_FETCH = 2000

# The bot group covers what the AppSec bot challenge produces. The engine
# stamps its rejections with kind bot-detection, and its two hub scenarios
# raise the bans.
BOT_KIND_GROUP = "bot"
BOT_CHALLENGE_SCENARIOS = (
    "crowdsecurity/appsec-bot-challenge-too-many-requests",
    "crowdsecurity/appsec-bot-challenge-too-many-submissions",
)

FLOOD_CONFLICT = "Too many alerts at the same moment to page past; filter by IP or scenario."
# The bot group takes no scenario filter.
BOT_FLOOD_CONFLICT = "Too many alerts at the same moment to page past; filter by IP."


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


def _covers_cursor(alerts: list[Alert], cursor: AlertCursor) -> bool:
    # The LAPI applies created_before to sub-second created_at but answers
    # whole seconds, so a cutoff can land inside the cursor's second and
    # drop the cursor while keeping an earlier alert from that second. Only
    # the cursor alert itself, or one from a later second, proves the
    # cutoff reached past it.
    return any(
        alert.id == cursor.id or _created_at(alert) > cursor.created_at for alert in alerts
    )


SourcePage = tuple[list[Alert], bool]


async def _grow_older(
    service: CrowdSecService,
    lapi_filters: dict[str, Any],
    alerts: list[Alert],
    *,
    limit: int,
    before: AlertCursor,
    created_before: str | None,
) -> SourcePage | Literal["exhausted"]:
    """Alerts older than ``before``, growing the fetch past newer rows from a
    first answer of ``limit`` rows.

    "exhausted" when ``MAX_FETCH`` rows hold nothing older.
    """
    fetch_limit = limit
    while True:
        full = len(alerts) == fetch_limit
        older = _older_than(alerts, before)
        if not full or len(older) >= limit:
            return older, full
        if fetch_limit < MAX_FETCH:
            fetch_limit = min(fetch_limit * 4, MAX_FETCH)
            alerts = await service.get_alerts(
                limit=fetch_limit, created_before=created_before, **lapi_filters
            )
            continue
        return (older, full) if older else "exhausted"


async def _first_answers(
    service: CrowdSecService,
    source_filters: list[dict[str, Any]],
    *,
    limit: int,
    created_before: str | None,
) -> list[list[Alert]]:
    return list(
        await asyncio.gather(
            *(
                service.get_alerts(limit=limit, created_before=created_before, **lapi_filters)
                for lapi_filters in source_filters
            )
        )
    )


async def _grow_all(
    service: CrowdSecService,
    source_filters: list[dict[str, Any]],
    answers: list[list[Alert]],
    *,
    limit: int,
    before: AlertCursor,
    created_before: str | None,
) -> list[SourcePage | Literal["exhausted"]]:
    return list(
        await asyncio.gather(
            *(
                _grow_older(
                    service, lapi_filters, alerts,
                    limit=limit, before=before, created_before=created_before,
                )
                for lapi_filters, alerts in zip(source_filters, answers, strict=True)
            )
        )
    )


def _older_than(alerts: list[Alert], cursor: AlertCursor) -> list[Alert]:
    cursor_key = (cursor.created_at, cursor.id)
    return [alert for alert in alerts if _sort_key(alert) < cursor_key]


def _flood_conflict(lapi_filters: dict[str, Any], detail: str) -> DomainConflictError:
    logger.warning("alert_page_flood_conflict", fetch_limit=MAX_FETCH, **lapi_filters)
    return DomainConflictError(detail)


async def _fetch_sources(
    service: CrowdSecService,
    source_filters: list[dict[str, Any]],
    *,
    limit: int,
    before: AlertCursor | None,
    now: datetime,
    conflict_detail: str,
) -> list[SourcePage]:
    """Alerts older than ``before`` from each LAPI query, and whether each
    LAPI answer was full (so more may follow)."""
    if before is None:
        answers = await _first_answers(service, source_filters, limit=limit, created_before=None)
        return [(alerts, len(alerts) == limit) for alerts in answers]
    # A cursor younger than the margin gets no cutoff, which makes this
    # first pass the clock-free one.
    margin_cutoff = _created_before(before, now, CURSOR_MARGIN)
    answers = await _first_answers(
        service, source_filters, limit=limit, created_before=margin_cutoff
    )
    # The LAPI counts created_before back from its own clock. An answer
    # that does not reach the cursor may come from a cutoff that sits
    # before it and has left older alerts out. The sources share that
    # clock and the cutoff, so one answer reaching the cursor proves the
    # cutoff for all of them, though the cursor alert sits in only one.
    if margin_cutoff is not None and not any(
        _covers_cursor(alerts, before) for alerts in answers
    ):
        for lapi_filters in source_filters:
            logger.info("alert_page_clock_free_fallback", **lapi_filters)
        answers = await _first_answers(service, source_filters, limit=limit, created_before=None)
        pages = await _grow_all(
            service, source_filters, answers, limit=limit, before=before, created_before=None
        )
        clock_free_pages: list[SourcePage] = []
        for lapi_filters, page in zip(source_filters, pages, strict=True):
            if isinstance(page, str):
                raise _flood_conflict(lapi_filters, conflict_detail)
            clock_free_pages.append(page)
        return clock_free_pages
    pages = await _grow_all(
        service, source_filters, answers, limit=limit, before=before, created_before=margin_cutoff
    )
    exhausted = [
        lapi_filters
        for lapi_filters, page in zip(source_filters, pages, strict=True)
        if isinstance(page, str)
    ]
    if not exhausted:
        return [page for page in pages if not isinstance(page, str)]
    # More than MAX_FETCH alerts sit inside the margin after the cursor.
    # A cutoff one second past the cursor's age reaches past them while
    # the clocks agree; the coverage check catches a LAPI clock behind
    # ours. A clock-free request would meet the same MAX_FETCH rows at
    # or after the cursor, so there is no further fallback.
    exact_cutoff = _created_before(before, now, EXACT_AGE_SLACK)
    if exact_cutoff is None or exact_cutoff == margin_cutoff:
        raise _flood_conflict(exhausted[0], conflict_detail)
    # Sources that did not run out ask too, with a page-sized limit: the
    # cursor alert may sit in one of them, and only it can prove the cutoff.
    answers = await asyncio.gather(
        *(
            service.get_alerts(
                limit=MAX_FETCH if isinstance(page, str) else limit,
                created_before=exact_cutoff,
                **lapi_filters,
            )
            for lapi_filters, page in zip(source_filters, pages, strict=True)
        )
    )
    if not any(_covers_cursor(alerts, before) for alerts in answers):
        raise _flood_conflict(exhausted[0], conflict_detail)
    exact_pages: list[SourcePage] = []
    for lapi_filters, page, alerts in zip(source_filters, pages, answers, strict=True):
        if not isinstance(page, str):
            exact_pages.append(page)
            continue
        older = _older_than(alerts, before)
        full = len(alerts) == MAX_FETCH
        if not older and full:
            raise _flood_conflict(lapi_filters, conflict_detail)
        exact_pages.append((older, full))
    return exact_pages


async def fetch_alert_page(
    service: CrowdSecService,
    filters: AlertFilters,
    *,
    limit: int,
    before: AlertCursor | None,
    now: datetime | None = None,
) -> AlertPage:
    """One page of alerts, newest first, older than ``before`` when given.

    The bot group and an IP filter page several LAPI queries at once and
    merge them.

    Raises:
        DomainConflictError: ``MAX_FETCH`` alerts at or after the cursor
            stand between it and anything older.
    """
    source_pages = await _fetch_sources(
        service,
        _source_filters(filters),
        limit=limit,
        before=before,
        now=now or datetime.now(UTC),
        conflict_detail=BOT_FLOOD_CONFLICT if filters.kind == BOT_KIND_GROUP else FLOOD_CONFLICT,
    )
    alerts = _merge_sources(source_pages)
    page_alerts = alerts[:limit]
    more = any(full for _, full in source_pages) or len(alerts) > limit
    return AlertPage(
        alerts=page_alerts,
        next_cursor=encode_cursor(page_alerts[-1]) if more and page_alerts else None,
    )


def _merge_sources(source_pages: list[SourcePage]) -> list[Alert]:
    """The sources' rows newest first, each alert once, ending where any
    full source's answer ends."""
    if len(source_pages) == 1:
        # The LAPI's own order breaks ties within a second by the sub-second
        # created_at that its answer drops, so a single source keeps it.
        return source_pages[0][0]
    unique = {alert.id: alert for older, _ in source_pages for alert in older}
    alerts = sorted(unique.values(), key=_sort_key, reverse=True)
    # A full source that answered short stopped at its last row, and the
    # rows it left out may be newer than another source's older rows.
    frontier = max(
        (_sort_key(older[-1]) for older, full in source_pages if full and older),
        default=None,
    )
    if frontier is None:
        return alerts
    return [alert for alert in alerts if _sort_key(alert) >= frontier]


def _source_filters(filters: AlertFilters) -> list[dict[str, Any]]:
    """One LAPI filter set per source: three for the bot group, one otherwise,
    and each of them twice under an IP filter."""
    shared: dict[str, Any] = {
        "since": filters.since,
        "has_active_decision": filters.has_active_decision,
    }
    if filters.kind == BOT_KIND_GROUP:
        sources = [
            {**shared, "scenario": None, "kind": "bot-detection"},
            *({**shared, "scenario": scenario, "kind": None} for scenario in BOT_CHALLENGE_SCENARIOS),
        ]
    else:
        sources = [{**shared, "scenario": filters.scenario, "kind": filters.kind}]
    if filters.ip is None:
        return sources
    # The LAPI's ip= only matches alerts holding a decision that covers the
    # IP, so a WAF alert without one needs the source match as well.
    source_value = canonical_ip(filters.ip) or filters.ip
    return [
        lapi_filters
        for source in sources
        for lapi_filters in (
            {**source, "scope": "Ip", "value": source_value},
            {**source, "ip": filters.ip},
        )
    ]
