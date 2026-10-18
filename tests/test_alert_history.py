"""Cursor paging over the LAPI alert history, against a LAPI simulator."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from geometrikks.domain.exceptions import DomainConflictError, DomainValidationError
from geometrikks.domain.security import alert_history
from geometrikks.domain.security.alert_history import (
    AlertCursor,
    AlertFilters,
    decode_cursor,
    encode_cursor,
    fetch_alert_page,
)
from geometrikks.services.crowdsec import Alert, CrowdSecService
from geometrikks.services.crowdsec.exceptions import CrowdSecUnsupportedError
from geometrikks.services.crowdsec.schemas import AlertSource

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
) -> Alert:
    return Alert(
        id=id,
        scenario=scenario,
        message=f"Ip {value} performed {scenario}",
        events_count=1,
        created_at=created_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        source=AlertSource(scope="Ip", value=value, ip=value),
        kind=kind,
    )


def alert_created_at(alert: Alert) -> datetime:
    return datetime.fromisoformat(alert.created_at)


def newest_first(alerts: list[Alert]) -> list[int | None]:
    ordered = sorted(alerts, key=lambda alert: (alert_created_at(alert), alert.id), reverse=True)
    return [alert.id for alert in ordered]


class SimulatedLapi(CrowdSecService):
    """GET /v1/alerts as pkg/database answers it: newest first by
    (created_at, id), ``created_before`` counted back from the LAPI's own clock."""

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
        scenario = filters.get("scenario")
        if scenario is not None:
            matching = [alert for alert in matching if alert.scenario == scenario]
        created_before = filters.get("created_before")
        if created_before is not None:
            assert created_before.endswith("s")
            boundary = self.now + self.clock_skew - timedelta(seconds=int(created_before[:-1]))
            matching = [alert for alert in matching if alert_created_at(alert) <= boundary]
        limit = filters.get("limit")
        return matching[:limit] if limit else matching


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


async def walk_pages(lapi: SimulatedLapi, *, limit: int = 50) -> list[int | None]:
    walked: list[int | None] = []
    cursor: str | None = None
    for _ in range(50):
        before = None if cursor is None else decode_cursor(cursor)
        page = await fetch_alert_page(lapi, AlertFilters(), limit=limit, before=before, now=NOW)
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
    # Nothing at or after the deleted cursor proves the cutoff reached it.
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


async def test_flood_newer_than_the_cursor_past_the_cap_conflicts(monkeypatch):
    # 151 alerts at or after the cursor, MAX_FETCH 100: neither the margin
    # pass nor the clock-free pass reaches an older alert.
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    alerts, cursor = cursor_flood()
    lapi = SimulatedLapi(alerts)
    with pytest.raises(DomainConflictError) as conflict:
        await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    assert conflict.value.detail == alert_history.FLOOD_CONFLICT
    age_with_margin = int((NOW - T0 - alert_history.CURSOR_MARGIN).total_seconds())
    assert [(call["limit"], call["created_before"]) for call in lapi.calls] == [
        (50, f"{age_with_margin}s"), (100, f"{age_with_margin}s"), (50, None), (100, None),
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


async def test_cursor_younger_than_the_margin_pages_without_a_cutoff(monkeypatch):
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    fresh = NOW - timedelta(minutes=2)
    lapi = SimulatedLapi([make_alert(id, fresh) for id in range(1, 301)])
    cursor = AlertCursor(created_at=fresh, id=150)
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


async def test_filters_reach_the_lapi():
    lapi = SimulatedLapi([make_alert(1, T0, scenario="crowdsecurity/ssh-bf")])
    filters = AlertFilters(
        ip="1.2.3.4", scenario="crowdsecurity/ssh-bf", since="24h", kind="crowdsec",
        has_active_decision=True,
    )
    await fetch_alert_page(lapi, filters, limit=50, before=None, now=NOW)
    (call,) = lapi.calls
    assert call == {
        "limit": 50, "created_before": None, "ip": "1.2.3.4", "scenario": "crowdsecurity/ssh-bf",
        "since": "24h", "kind": "crowdsec", "has_active_decision": True,
    }


def test_decode_cursor_rejects_garbage():
    with pytest.raises(DomainValidationError):
        decode_cursor("nope")


def test_cursor_round_trips():
    alert = make_alert(42, T0)
    assert decode_cursor(encode_cursor(alert)) == AlertCursor(alert_created_at(alert), 42)
