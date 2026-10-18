"""Cursor paging over the LAPI alert history, against a LAPI simulator."""

from __future__ import annotations

import ipaddress
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from structlog.testing import capture_logs

from geometrikks.domain.exceptions import DomainConflictError, DomainValidationError
from geometrikks.domain.security import alert_history
from geometrikks.domain.security.alert_history import (
    BOT_CHALLENGE_SCENARIOS,
    BOT_FLOOD_CONFLICT,
    BOT_KIND_GROUP,
    AlertCursor,
    AlertFilters,
    decode_cursor,
    encode_cursor,
    fetch_alert_page,
)
from geometrikks.services.crowdsec import Alert, CrowdSecService
from geometrikks.services.crowdsec.exceptions import CrowdSecUnsupportedError
from geometrikks.services.crowdsec.schemas import AlertSource, Decision

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 10, 18, 12, 0, 0, tzinfo=UTC)
T0 = NOW - timedelta(hours=6)


def make_alert(
    id: int,
    created_at: datetime,
    *,
    scenario: str = "crowdsecurity/http-probing",
    kind: str = "crowdsec",
    value: str = "1.2.3.4",
    decisions: list[Decision] | None = None,
) -> Alert:
    """A stored LAPI row. ``created_at`` keeps its fraction of a second, the
    way the LAPI database does; ``SimulatedLapi`` answers it whole-second."""
    return Alert(
        id=id,
        scenario=scenario,
        message=f"Ip {value} performed {scenario}",
        events_count=1,
        created_at=created_at.isoformat().replace("+00:00", "Z"),
        source=AlertSource(scope="Ip", value=value, ip=value),
        kind=kind,
        decisions=decisions or [],
    )


def alert_created_at(alert: Alert) -> datetime:
    return datetime.fromisoformat(alert.created_at)


def whole_second(alert: Alert) -> Alert:
    """The row as the LAPI answers it: ``created_at`` in RFC 3339 whole seconds."""
    return replace(alert, created_at=alert_created_at(alert).strftime("%Y-%m-%dT%H:%M:%SZ"))


def newest_first(alerts: list[Alert]) -> list[int | None]:
    ordered = sorted(alerts, key=lambda alert: (alert_created_at(alert), alert.id), reverse=True)
    return [alert.id for alert in ordered]


class SimulatedLapi(CrowdSecService):
    """GET /v1/alerts as pkg/database answers it: newest first by
    (created_at, id), ``created_before`` counted back from the LAPI's own clock.

    Ordering and the cutoff use the stored sub-second ``created_at``; the
    answer carries whole seconds, as the LAPI formats it with time.RFC3339."""

    def __init__(
        self,
        alerts: list[Alert],
        *,
        now: datetime = NOW,
        clock_skew: timedelta = timedelta(0),
        supports_kind: bool = True,
    ) -> None:
        self.alerts = alerts
        self.now = now
        self.clock_skew = clock_skew
        self.supports_kind = supports_kind
        self.calls: list[dict[str, Any]] = []

    async def get_alerts(self, **filters: Any) -> list[Alert]:
        self.calls.append(filters)
        kind = filters.get("kind")
        if kind is not None and not self.supports_kind:
            raise CrowdSecUnsupportedError("Filtering alerts by kind needs CrowdSec 1.7 or newer")
        matching = sorted(
            self.alerts, key=lambda alert: (alert_created_at(alert), alert.id), reverse=True
        )
        if kind is not None:
            matching = [alert for alert in matching if alert.kind == kind]
        ip = filters.get("ip")
        if ip is not None:
            # ip= matches the alert's decisions, never its own source.
            matching = [
                alert
                for alert in matching
                if any(decision_covers(decision, ip) for decision in alert.decisions)
            ]
        scope, value = filters.get("scope"), filters.get("value")
        if scope is not None:
            matching = [alert for alert in matching if alert.source.scope == scope]
        if value is not None:
            matching = [alert for alert in matching if alert.source.value == value]
        scenario = filters.get("scenario")
        if scenario is not None:
            # The LAPI matches the alert's scenario or any of its decisions'.
            matching = [
                alert
                for alert in matching
                if alert.scenario == scenario
                or any(decision.scenario == scenario for decision in alert.decisions)
            ]
        created_before = filters.get("created_before")
        if created_before is not None:
            assert created_before.endswith("s")
            boundary = self.now + self.clock_skew - timedelta(seconds=int(created_before[:-1]))
            matching = [alert for alert in matching if alert_created_at(alert) <= boundary]
        limit = filters.get("limit")
        return [whole_second(alert) for alert in (matching[:limit] if limit else matching)]


def decision_covers(decision: Decision, ip: str) -> bool:
    if decision.scope == "Ip":
        return decision.value == ip
    if decision.scope == "Range":
        return ipaddress.ip_address(ip) in ipaddress.ip_network(decision.value, strict=False)
    return False


async def test_first_page_is_newest_first_with_a_cursor_when_full():
    alerts = [make_alert(id, T0 + timedelta(seconds=id)) for id in range(1, 121)]
    lapi = SimulatedLapi(alerts)
    page = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=None, now=NOW)
    assert [alert.id for alert in page.alerts] == list(range(120, 70, -1))
    assert page.next_cursor is not None


async def test_short_last_page_has_no_cursor():
    alerts = [make_alert(id, T0 + timedelta(seconds=id)) for id in range(1, 31)]
    lapi = SimulatedLapi(alerts)
    page = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=None, now=NOW)
    assert len(page.alerts) == 30
    assert page.next_cursor is None


async def walk_pages(
    lapi: SimulatedLapi,
    *,
    limit: int = 50,
    now: datetime = NOW,
    filters: AlertFilters = AlertFilters(),
    start: AlertCursor | None = None,
) -> list[int | None]:
    walked: list[int | None] = []
    cursor: str | None = None
    for _ in range(50):
        before = start if cursor is None else decode_cursor(cursor)
        page = await fetch_alert_page(lapi, filters, limit=limit, before=before, now=now)
        walked.extend(alert.id for alert in page.alerts)
        cursor = page.next_cursor
        if cursor is None:
            return walked
    raise AssertionError("paging never ended")


@pytest.mark.parametrize("skew_seconds", [-330, -60, 0, 60])
async def test_walking_every_page_survives_lapi_clock_skew(skew_seconds):
    # Pairs of alerts share a second, so the id tie-break is exercised too.
    alerts = [
        make_alert(id, NOW - timedelta(hours=3) + timedelta(seconds=(id // 2) * 90))
        for id in range(1, 231)
    ]
    lapi = SimulatedLapi(alerts, clock_skew=timedelta(seconds=skew_seconds))
    walked = await walk_pages(lapi)
    assert walked == newest_first(alerts)
    assert len(set(walked)) == 230


async def test_flood_inside_margin_refetches():
    older = [make_alert(id, T0 - timedelta(seconds=51 - id)) for id in range(1, 51)]
    flood = [make_alert(id, T0) for id in range(51, 231)]
    lapi = SimulatedLapi(older + flood)
    first = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=None, now=NOW)
    assert {alert.id for alert in first.alerts} <= set(range(51, 231))
    assert first.next_cursor is not None
    last_id = first.alerts[-1].id
    assert last_id is not None

    second = await fetch_alert_page(
        lapi, AlertFilters(), limit=50, before=decode_cursor(first.next_cursor), now=NOW
    )
    assert len(second.alerts) == 50
    assert all(alert.id is not None and alert.id < last_id for alert in second.alerts)
    assert any(call["limit"] > 50 for call in lapi.calls)


def cursor_flood(*, older_spacing_seconds: int = 1) -> tuple[list[Alert], AlertCursor]:
    """Ten alerts before the cursor, the cursor's own alert at ``T0`` (id 11),
    and 150 newer alerts inside the margin, between ``T0 + 1 s`` and ``T0 + 120 s``."""
    before_cursor = [
        make_alert(id, T0 - timedelta(seconds=(11 - id) * older_spacing_seconds))
        for id in range(1, 11)
    ]
    cursor_alert = make_alert(11, T0)
    inside_margin = [
        make_alert(id, T0 + timedelta(seconds=1 + (id - 12) * 119 // 149))
        for id in range(12, 162)
    ]
    return before_cursor + [cursor_alert] + inside_margin, AlertCursor(created_at=T0, id=11)


LAPI_FAR_BEHIND = timedelta(seconds=-330)


@pytest.mark.parametrize("older_spacing_seconds", [1, 6])
async def test_lapi_clock_behind_by_more_than_the_margin_skips_nothing(older_spacing_seconds):
    alerts, cursor = cursor_flood(older_spacing_seconds=older_spacing_seconds)
    lapi = SimulatedLapi(alerts, clock_skew=LAPI_FAR_BEHIND)
    page = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    assert [alert.id for alert in page.alerts] == list(range(10, 0, -1))
    assert page.next_cursor is None
    assert lapi.calls[-1]["created_before"] is None


@pytest.mark.parametrize("older_spacing_seconds", [1, 6])
async def test_walking_with_a_lapi_clock_far_behind_returns_every_alert(older_spacing_seconds):
    alerts, _ = cursor_flood(older_spacing_seconds=older_spacing_seconds)
    lapi = SimulatedLapi(alerts, clock_skew=LAPI_FAR_BEHIND)
    walked = await walk_pages(lapi)
    assert walked == newest_first(alerts)
    assert len(set(walked)) == len(alerts)


def spaced_alerts(count: int) -> list[Alert]:
    """Alerts ten minutes apart, so nothing newer than one sits inside the margin."""
    return [make_alert(id, T0 - timedelta(minutes=10 * (count - id))) for id in range(1, count + 1)]


async def test_deleted_cursor_alert_still_pages_on():
    lapi = SimulatedLapi(spaced_alerts(120))
    first = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=None, now=NOW)
    assert first.next_cursor is not None
    cursor = decode_cursor(first.next_cursor)
    lapi.alerts = [alert for alert in lapi.alerts if alert.id != cursor.id]
    second = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    assert [alert.id for alert in second.alerts] == list(range(70, 20, -1))
    assert second.next_cursor is not None
    # Without the cursor alert, nothing in the answer proves the cutoff reached it.
    assert lapi.calls[-1]["created_before"] is None


async def test_cursor_alert_and_everything_older_deleted_ends_the_history():
    lapi = SimulatedLapi(spaced_alerts(120))
    first = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=None, now=NOW)
    assert first.next_cursor is not None
    cursor = decode_cursor(first.next_cursor)
    lapi.alerts = [alert for alert in lapi.alerts if alert.id is not None and alert.id > cursor.id]
    second = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    assert second.alerts == []
    assert second.next_cursor is None
    assert lapi.calls[-1]["created_before"] is None


async def test_flood_inside_the_margin_past_the_cap_pages_through_with_agreeing_clocks(monkeypatch):
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    alerts, cursor = cursor_flood()
    lapi = SimulatedLapi(alerts)
    page = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    assert [alert.id for alert in page.alerts] == list(range(10, 0, -1))
    assert page.next_cursor is None
    age_with_slack = int((NOW - T0 - alert_history.EXACT_AGE_SLACK).total_seconds())
    age_with_margin = int((NOW - T0 - alert_history.CURSOR_MARGIN).total_seconds())
    assert [(call["limit"], call["created_before"]) for call in lapi.calls] == [
        (50, f"{age_with_margin}s"), (100, f"{age_with_margin}s"), (100, f"{age_with_slack}s"),
    ]


async def test_deleted_cursor_inside_a_margin_flood_pages_through(monkeypatch):
    # With the cursor alert gone, the alerts from the second after it are
    # what proves the exact-age cutoff reached past the cursor.
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    alerts, cursor = cursor_flood()
    lapi = SimulatedLapi([alert for alert in alerts if alert.id != cursor.id])
    page = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    assert [alert.id for alert in page.alerts] == list(range(10, 0, -1))
    assert page.next_cursor is None
    age_with_slack = int((NOW - T0 - alert_history.EXACT_AGE_SLACK).total_seconds())
    age_with_margin = int((NOW - T0 - alert_history.CURSOR_MARGIN).total_seconds())
    assert [(call["limit"], call["created_before"]) for call in lapi.calls] == [
        (50, f"{age_with_margin}s"), (100, f"{age_with_margin}s"), (100, f"{age_with_slack}s"),
    ]


# Our clock has a fraction of a second, like datetime.now(). With agreeing
# clocks, a cutoff at the cursor's floored age lands at that fraction inside
# the cursor's second; one second of slack moves it into the next second.
SUBSECOND_NOW = NOW + timedelta(milliseconds=300)
# Milliseconds into T0's second for ids 11 to 16. Ids 11 and 12 sit before
# the 300 ms mark, ids 13 to 16 after it.
SAME_SECOND_MILLISECONDS = {11: 100, 12: 200, 13: 400, 14: 600, 15: 700, 16: 800}


def subsecond_alerts(*, newer: int) -> list[Alert]:
    """Ten alerts before ``T0``, six inside ``T0``'s second, and ``newer``
    alerts from id 17 up, spread over the two minutes after ``T0``."""
    before = [make_alert(id, T0 - timedelta(seconds=11 - id)) for id in range(1, 11)]
    same_second = [
        make_alert(id, T0 + timedelta(milliseconds=milliseconds))
        for id, milliseconds in SAME_SECOND_MILLISECONDS.items()
    ]
    after = [
        make_alert(id, T0 + timedelta(seconds=1 + (id - 17) * 119 // max(newer - 1, 1)))
        for id in range(17, 17 + newer)
    ]
    return before + same_second + after


@pytest.mark.parametrize(
    "newer", [145, 149], ids=["page-break-on-id-12-before-the-mark", "page-break-on-id-16-after-it"]
)
async def test_walk_through_a_flood_with_several_alerts_in_the_cursor_second(monkeypatch, newer):
    # 149 alerts above the cursor put the third page break on it, so page
    # four runs the exact-age pass from a cursor inside T0's second.
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    alerts = subsecond_alerts(newer=newer)
    lapi = SimulatedLapi(alerts, now=SUBSECOND_NOW)
    walked = await walk_pages(lapi, now=SUBSECOND_NOW)
    assert walked == newest_first(alerts)
    assert len(set(walked)) == len(alerts)
    age_with_slack = int((SUBSECOND_NOW - T0 - alert_history.EXACT_AGE_SLACK).total_seconds())
    assert (lapi.calls[-1]["limit"], lapi.calls[-1]["created_before"]) == (100, f"{age_with_slack}s")


async def test_exact_age_pass_keeps_the_cursor_whole_second_inside_the_cutoff(monkeypatch):
    # The re-review probe: the cursor sits at T0 + 800 ms and a cutoff at
    # the floored age would land at T0 + 300 ms, dropping the cursor and
    # ids 13 to 15 while keeping id 11. The slack moves the cutoff to
    # T0 + 1.3 s, so the whole second comes back and nothing is skipped.
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    lapi = SimulatedLapi(subsecond_alerts(newer=150), now=SUBSECOND_NOW)
    cursor = AlertCursor(created_at=T0, id=16)
    page = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=SUBSECOND_NOW)
    assert [alert.id for alert in page.alerts] == list(range(15, 0, -1))
    assert page.next_cursor is None
    age_with_slack = int((SUBSECOND_NOW - T0 - alert_history.EXACT_AGE_SLACK).total_seconds())
    age_with_margin = int((SUBSECOND_NOW - T0 - alert_history.CURSOR_MARGIN).total_seconds())
    assert [(call["limit"], call["created_before"]) for call in lapi.calls] == [
        (50, f"{age_with_margin}s"), (100, f"{age_with_margin}s"), (100, f"{age_with_slack}s"),
    ]


async def test_flood_across_the_cursor_second_and_the_next_conflicts(monkeypatch):
    # The slack reaches the next second, so a flood filling both seconds is
    # what the exact-age pass cannot get past.
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    this_second = [make_alert(id, T0 + timedelta(milliseconds=id)) for id in range(1, 151)]
    next_second = [make_alert(id, T0 + timedelta(seconds=1, milliseconds=id)) for id in range(151, 301)]
    lapi = SimulatedLapi(this_second + next_second, now=SUBSECOND_NOW)
    cursor = AlertCursor(created_at=T0, id=75)
    with pytest.raises(DomainConflictError) as conflict:
        await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=SUBSECOND_NOW)
    assert conflict.value.detail == alert_history.FLOOD_CONFLICT
    age_with_slack = int((SUBSECOND_NOW - T0 - alert_history.EXACT_AGE_SLACK).total_seconds())
    age_with_margin = int((SUBSECOND_NOW - T0 - alert_history.CURSOR_MARGIN).total_seconds())
    assert [(call["limit"], call["created_before"]) for call in lapi.calls] == [
        (50, f"{age_with_margin}s"), (100, f"{age_with_margin}s"), (100, f"{age_with_slack}s"),
    ]


def in_second_flood() -> list[Alert]:
    """300 alerts in ``T0``'s second and five in the next, so a margin answer
    holds a later second and covers a cursor inside the flood."""
    same_second = [make_alert(id, T0) for id in range(1, 301)]
    next_second = [make_alert(id, T0 + timedelta(seconds=1)) for id in range(301, 306)]
    return same_second + next_second


async def test_exact_age_pass_is_skipped_when_it_would_repeat_the_margin_cutoff(monkeypatch):
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    monkeypatch.setattr(alert_history, "CURSOR_MARGIN", alert_history.EXACT_AGE_SLACK)
    lapi = SimulatedLapi(in_second_flood())
    cursor = AlertCursor(created_at=T0, id=150)
    with pytest.raises(DomainConflictError):
        await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    age_with_slack = int((NOW - T0 - alert_history.EXACT_AGE_SLACK).total_seconds())
    assert [(call["limit"], call["created_before"]) for call in lapi.calls] == [
        (50, f"{age_with_slack}s"), (100, f"{age_with_slack}s"),
    ]


async def test_margin_cutoff_inside_the_cursor_second_takes_the_clock_free_pass():
    # A LAPI clock behind ours by the whole margin puts the margin cutoff at
    # T0 + 300 ms, between the cursor (id 16 at T0 + 800 ms) and ids 12 to 15.
    alerts = subsecond_alerts(newer=49)
    lapi = SimulatedLapi(alerts, now=SUBSECOND_NOW, clock_skew=-alert_history.CURSOR_MARGIN)
    walked = await walk_pages(lapi, now=SUBSECOND_NOW)
    assert walked == newest_first(alerts)
    assert len(set(walked)) == len(alerts)
    age_with_margin = int((SUBSECOND_NOW - T0 - alert_history.CURSOR_MARGIN).total_seconds())
    assert [(call["limit"], call["created_before"]) for call in lapi.calls] == [
        (50, None), (50, f"{age_with_margin}s"), (50, None), (200, None),
    ]


@pytest.mark.parametrize("skew", [timedelta(0), LAPI_FAR_BEHIND], ids=["clocks-agree", "lapi-far-behind"])
async def test_full_answer_at_the_cap_with_a_few_older_rows_keeps_a_cursor(monkeypatch, skew):
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    older = [make_alert(id, T0 - timedelta(seconds=61 - id)) for id in range(1, 61)]
    cursor_alert = make_alert(61, T0)
    newer = [make_alert(id, T0 + timedelta(seconds=id - 61)) for id in range(62, 157)]
    lapi = SimulatedLapi(older + [cursor_alert] + newer, clock_skew=skew)
    cursor = AlertCursor(created_at=T0, id=61)
    page = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    assert [alert.id for alert in page.alerts] == [60, 59, 58, 57]
    assert page.next_cursor is not None
    assert decode_cursor(page.next_cursor) == AlertCursor(created_at=T0 - timedelta(seconds=4), id=57)
    clock_free = [call for call in lapi.calls if call["created_before"] is None]
    assert bool(clock_free) == (skew != timedelta(0))


async def test_cursor_younger_than_the_margin_starts_without_a_cutoff(monkeypatch):
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    fresh = NOW - timedelta(minutes=2)
    lapi = SimulatedLapi([make_alert(id, fresh) for id in range(1, 301)])
    cursor = AlertCursor(created_at=fresh, id=150)
    with pytest.raises(DomainConflictError):
        await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    # The exact-age pass still runs; the flood shares the cursor's second,
    # and with it uncovered the page is a conflict with no further request.
    assert [(call["limit"], call["created_before"]) for call in lapi.calls] == [
        (50, None), (100, None), (100, "119s"),
    ]


async def test_flood_after_a_cursor_younger_than_the_margin_pages_through(monkeypatch):
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    fresh = NOW - timedelta(minutes=2)
    older = [make_alert(id, fresh - timedelta(seconds=11 - id)) for id in range(1, 11)]
    cursor_alert = make_alert(11, fresh)
    newer = [make_alert(id, fresh + timedelta(seconds=1 + (id - 12) * 109 // 149)) for id in range(12, 162)]
    lapi = SimulatedLapi(older + [cursor_alert] + newer)
    cursor = AlertCursor(created_at=fresh, id=11)
    page = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    assert [alert.id for alert in page.alerts] == list(range(10, 0, -1))
    assert page.next_cursor is None
    assert lapi.calls[-1]["created_before"] == "119s"


@pytest.mark.parametrize("age", [timedelta(0), timedelta(seconds=1)], ids=["this-second", "last-second"])
async def test_cursor_younger_than_the_slack_skips_the_exact_age_pass(monkeypatch, age):
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    lapi = SimulatedLapi([make_alert(id, NOW - age) for id in range(1, 301)])
    cursor = AlertCursor(created_at=NOW - age, id=150)
    with pytest.raises(DomainConflictError):
        await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    assert [(call["limit"], call["created_before"]) for call in lapi.calls] == [(50, None), (100, None)]


async def test_flood_at_the_cursor_second_conflicts(monkeypatch):
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    lapi = SimulatedLapi([make_alert(id, T0) for id in range(1, 301)])
    cursor = AlertCursor(created_at=T0, id=150)
    with pytest.raises(DomainConflictError) as conflict:
        await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    assert conflict.value.detail == (
        "Too many alerts at the same moment to page past; filter by IP or scenario."
    )


async def test_exhausted_margin_pass_with_an_uncovered_exact_age_answer_conflicts_at_once(monkeypatch):
    # An exhausted margin pass already saw MAX_FETCH rows at or after the
    # cursor, so an uncovered exact-age answer ends in the 409 with no
    # clock-free request.
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    lapi = SimulatedLapi(in_second_flood())
    cursor = AlertCursor(created_at=T0, id=150)
    with pytest.raises(DomainConflictError):
        await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    age_with_slack = int((NOW - T0 - alert_history.EXACT_AGE_SLACK).total_seconds())
    age_with_margin = int((NOW - T0 - alert_history.CURSOR_MARGIN).total_seconds())
    assert [(call["limit"], call["created_before"]) for call in lapi.calls] == [
        (50, f"{age_with_margin}s"), (100, f"{age_with_margin}s"), (100, f"{age_with_slack}s"),
    ]


async def test_filters_reach_the_lapi():
    lapi = SimulatedLapi([make_alert(1, T0, scenario="crowdsecurity/ssh-bf")])
    filters = AlertFilters(
        ip="1.2.3.4", scenario="crowdsecurity/ssh-bf", since="24h", kind="crowdsec",
        has_active_decision=True,
    )
    await fetch_alert_page(lapi, filters, limit=50, before=None, now=NOW)
    shared = {
        "limit": 50, "created_before": None, "scenario": "crowdsecurity/ssh-bf",
        "since": "24h", "kind": "crowdsec", "has_active_decision": True,
    }
    assert sorted(lapi.calls, key=lambda call: "ip" in call) == [
        {**shared, "scope": "Ip", "value": "1.2.3.4"},
        {**shared, "ip": "1.2.3.4"},
    ]


async def test_filters_without_an_ip_send_one_query():
    lapi = SimulatedLapi([make_alert(1, T0)])
    await fetch_alert_page(lapi, AlertFilters(since="24h"), limit=50, before=None, now=NOW)
    (call,) = lapi.calls
    assert "ip" not in call
    assert "value" not in call


def ip_decision(id: int, value: str, scope: str = "Ip") -> Decision:
    return Decision(
        id=id, origin="crowdsec", type="ban", scope=scope, value=value, duration="3h59m",
        scenario="crowdsecurity/http-probing",
    )


async def test_ip_filter_returns_alerts_from_the_source_and_alerts_deciding_on_it():
    alerts = [
        make_alert(1, T0, kind="waf", value="5.6.7.8", scenario="crowdsecurity/vpatch-env-access"),
        make_alert(2, T0 + timedelta(seconds=10), value="5.6.7.8", decisions=[ip_decision(2, "5.6.7.8")]),
        make_alert(3, T0 + timedelta(seconds=20), value="9.9.9.9"),
        # Raised against another source, with a range decision covering the IP.
        make_alert(
            4, T0 + timedelta(seconds=30), value="5.6.0.1",
            decisions=[ip_decision(4, "5.6.0.0/16", "Range")],
        ),
        make_alert(5, T0 + timedelta(seconds=40), kind="waf", value="9.9.9.9"),
    ]
    lapi = SimulatedLapi(alerts)
    page = await fetch_alert_page(lapi, AlertFilters(ip="5.6.7.8"), limit=50, before=None, now=NOW)
    assert [alert.id for alert in page.alerts] == [4, 2, 1]
    assert page.next_cursor is None


async def test_ip_filter_matches_the_source_in_canonical_form():
    lapi = SimulatedLapi([make_alert(1, T0, kind="waf", value="2001:db8::1")])
    page = await fetch_alert_page(
        lapi, AlertFilters(ip="2001:DB8:0::1"), limit=50, before=None, now=NOW
    )
    assert [alert.id for alert in page.alerts] == [1]


async def test_ip_filter_walks_every_page_once():
    # Pairs of alerts share a second. Every third alert is a decision-less
    # WAF hit from the IP, every third a ban on it, the rest another source.
    alerts: list[Alert] = []
    for id in range(1, 301):
        created_at = NOW - timedelta(hours=5) + timedelta(seconds=(id // 2) * 45)
        if id % 3 == 0:
            alerts.append(make_alert(id, created_at, kind="waf", value="5.6.7.8"))
        elif id % 3 == 1:
            ban = ip_decision(id, "5.6.7.8")
            alerts.append(make_alert(id, created_at, value="5.6.7.8", decisions=[ban]))
        else:
            alerts.append(make_alert(id, created_at, value="9.9.9.9"))
    matching = [alert for alert in alerts if alert.source.value == "5.6.7.8"]
    lapi = SimulatedLapi(alerts)
    walked = await walk_pages(lapi, filters=AlertFilters(ip="5.6.7.8"))
    assert walked == newest_first(matching)
    assert len(walked) == len(set(walked)) == 200


REJECTED_SUBMISSION = "crowdsecurity/rejected-browser-submission"
TOO_MANY_REQUESTS, TOO_MANY_SUBMISSIONS = BOT_CHALLENGE_SCENARIOS
BOT_GROUP = AlertFilters(kind=BOT_KIND_GROUP)


def bot_rejection(id: int, created_at: datetime) -> Alert:
    return make_alert(id, created_at, scenario=REJECTED_SUBMISSION, kind="bot-detection")


def bot_ban(id: int, created_at: datetime, scenario: str = TOO_MANY_REQUESTS) -> Alert:
    decision = Decision(
        id=id, origin="crowdsec", type="ban", scope="Ip", value="1.2.3.4", duration="3h59m",
        scenario=scenario,
    )
    return make_alert(id, created_at, scenario=scenario, decisions=[decision])


async def test_bot_group_queries_the_rejection_kind_and_both_ban_scenarios():
    # Each source holds an alert a minute after the cursor, which proves the
    # margin cutoff reached it, so every source answers in one request.
    alerts = [
        bot_rejection(1, T0 - timedelta(minutes=1)),
        bot_rejection(2, T0 + timedelta(minutes=1)),
        bot_ban(3, T0 - timedelta(minutes=1), TOO_MANY_REQUESTS),
        bot_ban(4, T0 + timedelta(minutes=1), TOO_MANY_REQUESTS),
        bot_ban(5, T0 - timedelta(minutes=1), TOO_MANY_SUBMISSIONS),
        bot_ban(6, T0 + timedelta(minutes=1), TOO_MANY_SUBMISSIONS),
    ]
    lapi = SimulatedLapi(alerts)
    filters = AlertFilters(ip="1.2.3.4", since="24h", kind=BOT_KIND_GROUP)
    cursor = AlertCursor(created_at=T0, id=100)
    await fetch_alert_page(lapi, filters, limit=50, before=cursor, now=NOW)
    age_with_margin = int((NOW - T0 - alert_history.CURSOR_MARGIN).total_seconds())
    shared = {
        "limit": 50, "created_before": f"{age_with_margin}s", "since": "24h",
        "has_active_decision": None,
    }
    by_ip = {"ip": "1.2.3.4"}
    by_source = {"scope": "Ip", "value": "1.2.3.4"}
    assert sorted(
        lapi.calls, key=lambda call: (call["kind"] or "", call["scenario"] or "", "ip" in call)
    ) == [
        {**shared, "scenario": TOO_MANY_REQUESTS, "kind": None, **by_source},
        {**shared, "scenario": TOO_MANY_REQUESTS, "kind": None, **by_ip},
        {**shared, "scenario": TOO_MANY_SUBMISSIONS, "kind": None, **by_source},
        {**shared, "scenario": TOO_MANY_SUBMISSIONS, "kind": None, **by_ip},
        {**shared, "scenario": None, "kind": "bot-detection", **by_source},
        {**shared, "scenario": None, "kind": "bot-detection", **by_ip},
    ]


async def test_bot_group_with_an_ip_merges_six_sources():
    # The rejections carry no decision, so only the source match finds them;
    # the bans come back from both queries of their scenario.
    alerts = [
        bot_rejection(1, T0),
        bot_ban(2, T0 + timedelta(seconds=10), TOO_MANY_SUBMISSIONS),
        bot_rejection(3, T0 + timedelta(seconds=20)),
        bot_ban(4, T0 + timedelta(seconds=30), TOO_MANY_REQUESTS),
        make_alert(5, T0 + timedelta(seconds=40), decisions=[ip_decision(5, "1.2.3.4")]),
        bot_rejection(6, T0 + timedelta(seconds=50)),
    ]
    other_source = AlertSource(scope="Ip", value="9.9.9.9", ip="9.9.9.9")
    alerts.append(replace(bot_rejection(7, T0 + timedelta(seconds=60)), source=other_source))
    lapi = SimulatedLapi(alerts)
    filters = AlertFilters(ip="1.2.3.4", kind=BOT_KIND_GROUP)
    page = await fetch_alert_page(lapi, filters, limit=50, before=None, now=NOW)
    assert len(lapi.calls) == 6
    assert [alert.id for alert in page.alerts] == [6, 4, 3, 2, 1]
    assert page.next_cursor is None


async def test_bot_group_merges_newest_first_and_drops_duplicates():
    # Alert 3 fired on too-many-requests and holds a too-many-submissions
    # decision too, so both scenario queries answer it.
    both_scenarios = bot_ban(3, T0 + timedelta(seconds=30), TOO_MANY_REQUESTS)
    both_scenarios.decisions.append(replace(both_scenarios.decisions[0], scenario=TOO_MANY_SUBMISSIONS))
    alerts = [
        bot_rejection(1, T0),
        bot_ban(2, T0 + timedelta(seconds=10), TOO_MANY_SUBMISSIONS),
        both_scenarios,
        bot_rejection(4, T0 + timedelta(seconds=40)),
        bot_ban(5, T0 + timedelta(seconds=50), TOO_MANY_REQUESTS),
        make_alert(6, T0 + timedelta(seconds=60)),
    ]
    lapi = SimulatedLapi(alerts)
    page = await fetch_alert_page(lapi, BOT_GROUP, limit=50, before=None, now=NOW)
    assert [alert.id for alert in page.alerts] == [5, 4, 3, 2, 1]
    assert page.next_cursor is None


async def test_bot_group_cuts_the_merge_to_the_limit_with_a_cursor():
    alerts = [bot_rejection(id, T0 + timedelta(seconds=id)) for id in range(1, 4)]
    alerts += [bot_ban(id, T0 + timedelta(seconds=id)) for id in range(4, 7)]
    lapi = SimulatedLapi(alerts)
    page = await fetch_alert_page(lapi, BOT_GROUP, limit=4, before=None, now=NOW)
    assert [alert.id for alert in page.alerts] == [6, 5, 4, 3]
    assert page.next_cursor is not None
    assert decode_cursor(page.next_cursor) == AlertCursor(T0 + timedelta(seconds=3), 3)


def bot_day() -> tuple[list[Alert], list[Alert]]:
    """140 rejections ten minutes apart and 7 too-many-requests bans over a
    day, plus 50 unrelated http-probing alerts. Every bot alert sits more
    than the margin away from the next one in its own source, so only the
    cursor's own source proves a cutoff. Returns the bot alerts and all of them."""
    day_start = NOW - timedelta(hours=24)
    rejections = [bot_rejection(id, day_start + timedelta(minutes=10 * id)) for id in range(1, 141)]
    bans = [
        bot_ban(140 + index, day_start + timedelta(hours=3 * index, minutes=2))
        for index in range(1, 8)
    ]
    probes = [
        make_alert(147 + index, day_start + timedelta(minutes=28 * index + 1))
        for index in range(1, 51)
    ]
    bot_alerts = rejections + bans
    return bot_alerts, bot_alerts + probes


async def test_bot_group_walks_every_page_in_order():
    bot_alerts, alerts = bot_day()
    lapi = SimulatedLapi(alerts)
    walked: list[int | None] = []
    cursor: str | None = None
    with capture_logs() as logs:
        for _ in range(10):
            before = None if cursor is None else decode_cursor(cursor)
            page = await fetch_alert_page(lapi, BOT_GROUP, limit=50, before=before, now=NOW)
            walked.extend(alert.id for alert in page.alerts)
            cursor = page.next_cursor
            if len(walked) < len(bot_alerts):
                assert cursor is not None, f"no cursor after {len(walked)} of {len(bot_alerts)}"
            if cursor is None:
                break
    assert walked == newest_first(bot_alerts)
    assert len(walked) == 147
    assert [log for log in logs if log["event"] == "alert_page_clock_free_fallback"] == []


def ban_in_a_rejection_gap(*, newer: int) -> list[Alert]:
    """100 old rejections, a ban ten minutes past them and ``newer``
    rejections from ten minutes after the ban."""
    start = NOW - timedelta(hours=10)
    older = [bot_rejection(id, start + timedelta(seconds=id)) for id in range(1, 101)]
    ban = bot_ban(5000, start + timedelta(minutes=30))
    newer_rejections = [
        bot_rejection(1000 + index, start + timedelta(minutes=40, seconds=index))
        for index in range(1, newer + 1)
    ]
    return older + [ban] + newer_rejections


async def test_bot_group_ban_cursor_in_a_rejection_gap_pages_through(monkeypatch):
    # 249 newer rejections put the fifth page break on the ban. Only the ban
    # source holds the cursor; its answer proves the cutoff for the rejection
    # source, which would otherwise go clock-free and run out of rows.
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    alerts = ban_in_a_rejection_gap(newer=249)
    lapi = SimulatedLapi(alerts)
    with capture_logs() as logs:
        walked = await walk_pages(lapi, filters=BOT_GROUP)
    assert walked == newest_first(alerts)
    assert [log for log in logs if log["event"] == "alert_page_clock_free_fallback"] == []


async def test_bot_group_with_a_lapi_clock_far_behind_takes_the_clock_free_pass():
    bot_alerts, alerts = bot_day()
    lapi = SimulatedLapi(alerts, clock_skew=LAPI_FAR_BEHIND)
    walked: list[int | None] = []
    fallbacks_per_page: list[int] = []
    cursor: str | None = None
    while True:
        before = None if cursor is None else decode_cursor(cursor)
        with capture_logs() as logs:
            page = await fetch_alert_page(lapi, BOT_GROUP, limit=50, before=before, now=NOW)
        fallbacks = [log for log in logs if log["event"] == "alert_page_clock_free_fallback"]
        fallbacks_per_page.append(len(fallbacks))
        for fallback in fallbacks:
            assert fallback["sources"] == 3
            assert fallback["kind"] == BOT_KIND_GROUP
            assert fallback["scenario"] is None
        walked.extend(alert.id for alert in page.alerts)
        cursor = page.next_cursor
        if cursor is None:
            break
    assert walked == newest_first(bot_alerts)
    assert fallbacks_per_page[0] == 0
    assert set(fallbacks_per_page[1:]) == {1}


async def test_bot_group_exact_age_pass_takes_its_proof_from_the_cursor_source(monkeypatch):
    # The rejection source runs out of rows inside the margin and goes to
    # the exact-age cutoff, where it holds nothing from the cursor's second
    # or later. The ban source holds the cursor and proves that cutoff.
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    older = [bot_rejection(id, T0 - timedelta(seconds=11 - id)) for id in range(1, 11)]
    ban = bot_ban(500, T0)
    flood = [bot_rejection(id, T0 + timedelta(seconds=2 + (id - 11) * 118 // 149)) for id in range(11, 161)]
    lapi = SimulatedLapi(older + [ban] + flood)
    page = await fetch_alert_page(
        lapi, BOT_GROUP, limit=50, before=AlertCursor(created_at=T0, id=500), now=NOW
    )
    assert [alert.id for alert in page.alerts] == list(range(10, 0, -1))
    assert page.next_cursor is None


async def test_bot_group_flood_conflict_does_not_advise_a_scenario_filter(monkeypatch):
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    lapi = SimulatedLapi([bot_rejection(id, T0) for id in range(1, 301)])
    cursor = AlertCursor(created_at=T0, id=150)
    with pytest.raises(DomainConflictError) as conflict:
        await fetch_alert_page(lapi, BOT_GROUP, limit=50, before=cursor, now=NOW)
    assert conflict.value.detail == BOT_FLOOD_CONFLICT
    assert "scenario" not in BOT_FLOOD_CONFLICT


async def test_bot_group_stops_at_a_full_source_that_answered_short(monkeypatch):
    # The rejection source hits MAX_FETCH with only four rows past the
    # cursor. Its fifth may be older than the ban, so the page ends at its
    # fourth row instead of filling up with the ban.
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    older = [bot_rejection(id, T0 - timedelta(seconds=61 - id)) for id in range(1, 61)]
    cursor_alert = bot_rejection(61, T0)
    newer = [bot_rejection(id, T0 + timedelta(seconds=id - 61)) for id in range(62, 157)]
    ban = bot_ban(200, T0 - timedelta(seconds=10, milliseconds=500))
    lapi = SimulatedLapi(older + [cursor_alert] + newer + [ban])
    cursor = AlertCursor(created_at=T0, id=61)
    page = await fetch_alert_page(lapi, BOT_GROUP, limit=50, before=cursor, now=NOW)
    assert [alert.id for alert in page.alerts] == [60, 59, 58, 57]
    assert page.next_cursor is not None
    walked = await walk_pages(lapi, filters=BOT_GROUP, start=cursor)
    assert walked == newest_first(older + [ban])


async def test_bot_group_on_an_old_lapi_raises_unsupported():
    lapi = SimulatedLapi([bot_ban(1, T0)], supports_kind=False)
    with pytest.raises(CrowdSecUnsupportedError):
        await fetch_alert_page(lapi, BOT_GROUP, limit=50, before=None, now=NOW)


def test_decode_cursor_rejects_garbage():
    with pytest.raises(DomainValidationError):
        decode_cursor("nope")


def test_cursor_round_trips():
    alert = make_alert(42, T0)
    assert decode_cursor(encode_cursor(alert)) == AlertCursor(alert_created_at(alert), 42)
