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


@pytest.mark.parametrize("skew_seconds", [-60, 0, 60])
async def test_walking_every_page_survives_lapi_clock_skew(skew_seconds):
    # Pairs of alerts share a second, so the id tie-break is exercised too.
    alerts = [
        make_alert(id, NOW - timedelta(hours=3) + timedelta(seconds=(id // 2) * 90))
        for id in range(1, 231)
    ]
    lapi = SimulatedLapi(alerts, clock_skew=timedelta(seconds=skew_seconds))
    walked: list[int | None] = []
    cursor: str | None = None
    for _ in range(20):
        before = None if cursor is None else decode_cursor(cursor)
        page = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=before, now=NOW)
        walked.extend(alert.id for alert in page.alerts)
        cursor = page.next_cursor
        if cursor is None:
            break
    assert cursor is None
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


async def test_flood_past_the_cap_falls_back_to_no_margin(monkeypatch):
    monkeypatch.setattr(alert_history, "MAX_FETCH", 100)
    before_cursor = [make_alert(id, T0 - timedelta(seconds=11 - id)) for id in range(1, 11)]
    inside_margin = [
        make_alert(id, T0 + timedelta(seconds=1 + (id - 11) * 119 // 149))
        for id in range(11, 161)
    ]
    lapi = SimulatedLapi(before_cursor + inside_margin)
    cursor = AlertCursor(created_at=T0, id=10_000)
    page = await fetch_alert_page(lapi, AlertFilters(), limit=50, before=cursor, now=NOW)
    assert [alert.id for alert in page.alerts] == list(range(10, 0, -1))
    assert page.next_cursor is None
    age_seconds = int((NOW - T0).total_seconds())
    assert lapi.calls[-1]["created_before"] == f"{age_seconds}s"


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
