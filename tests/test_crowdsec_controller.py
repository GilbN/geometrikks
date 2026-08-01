"""CrowdSec API: status, decisions (paginated + enriched), lookup, stats."""
from __future__ import annotations

from typing import Any

from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient

from geometrikks.api.v1.crowdsec_controller import CrowdSecController
from geometrikks.server.exceptions import EXCEPTION_HANDLERS
from geometrikks.domain.security.repositories import SecurityEnrichmentRepository
from geometrikks.domain.security.schemas import IpEnrichment
from geometrikks.services.crowdsec import CrowdSecService, Decision
from tests.support import ambient_settings_dependency

import pytest

pytestmark = pytest.mark.anyio


def make_decision(**overrides: Any) -> Decision:
    values: dict[str, Any] = {
        "id": 1,
        "origin": "cscli",
        "type": "ban",
        "scope": "Ip",
        "value": "1.2.3.4",
        "duration": "3h59m",
        "scenario": "manual ban",
        **overrides,
    }
    return Decision(**values)


class FakeCrowdSec(CrowdSecService):
    def __init__(self, decisions: list[Decision], *, reachable: bool = True) -> None:
        self._decisions = decisions
        self._reachable = reachable
        self.calls: list[dict[str, Any]] = []

    async def get_decisions(self, **filters: Any) -> list[Decision]:
        self.calls.append(filters)
        ip = filters.get("ip")
        if ip is not None:
            return [d for d in self._decisions if d.value == ip]
        return self._decisions

    async def ping(self) -> bool:
        return self._reachable


class FakeEnrichment(SecurityEnrichmentRepository):
    def __init__(self, data: dict[str, IpEnrichment]) -> None:
        self._data = data
        self.calls: list[list[str]] = []

    async def enrich(self, ips: list[str]) -> dict[str, IpEnrichment]:
        self.calls.append(ips)
        return {ip: self._data[ip] for ip in ips if ip in self._data}


def make_app(
    service: FakeCrowdSec | None,
    enrichment: FakeEnrichment | None = None,
) -> Litestar:
    enrichment = enrichment if enrichment is not None else FakeEnrichment({})

    class _TestController(CrowdSecController):
        dependencies = {
            **CrowdSecController.dependencies,
            "enrichment_repo": Provide(lambda: enrichment, sync_to_thread=False),
        }

    app = Litestar(
        route_handlers=[_TestController],
        # limit_offset comes controller-scoped from CrowdSecController itself.
        dependencies=ambient_settings_dependency(),
        # Production wiring: create_app() registers the same central map.
        exception_handlers=EXCEPTION_HANDLERS,
    )
    app.state.crowdsec_service = service
    return app


OSLO = IpEnrichment(
    country_code="NO", country_name="Norway", city="Oslo", request_count_24h=7
)


async def test_status_disabled():
    async with AsyncTestClient(app=make_app(None)) as client:
        resp = await client.get("/api/v1/crowdsec/status")
    assert resp.status_code == 200
    assert resp.json() == {
        "enabled": False,
        "write_enabled": False,
        "lapi_reachable": False,
    }


async def test_status_enabled_read_only(monkeypatch, tmp_path):
    # chdir away from the repo so a local .env with machine creds can't leak in
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    async with AsyncTestClient(app=make_app(FakeCrowdSec([]))) as client:
        resp = await client.get("/api/v1/crowdsec/status")
    assert resp.json() == {
        "enabled": True,
        "write_enabled": False,
        "lapi_reachable": True,
    }


async def test_status_write_enabled(monkeypatch):
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    monkeypatch.setenv("CROWDSEC_MACHINE_ID", "geometrikks")
    monkeypatch.setenv("CROWDSEC_MACHINE_PASSWORD", "pass")
    async with AsyncTestClient(app=make_app(FakeCrowdSec([]))) as client:
        resp = await client.get("/api/v1/crowdsec/status")
    assert resp.json()["write_enabled"] is True


async def test_status_reports_unreachable_lapi():
    async with AsyncTestClient(
        app=make_app(FakeCrowdSec([], reachable=False))
    ) as client:
        resp = await client.get("/api/v1/crowdsec/status")
    assert resp.json()["lapi_reachable"] is False


async def test_decisions_404_when_disabled():
    async with AsyncTestClient(app=make_app(None)) as client:
        assert (await client.get("/api/v1/crowdsec/decisions")).status_code == 404
        assert (
            await client.get("/api/v1/crowdsec/decisions/lookup", params={"ip": "1.1.1.1"})
        ).status_code == 404
        assert (await client.get("/api/v1/crowdsec/stats")).status_code == 404


async def test_decisions_enriches_ip_scope_only():
    decisions = [
        make_decision(id=1, value="1.2.3.4", scope="Ip"),
        make_decision(id=2, value="10.0.0.0/24", scope="Range", origin="crowdsec"),
    ]
    enrichment = FakeEnrichment({"1.2.3.4": OSLO})
    async with AsyncTestClient(app=make_app(FakeCrowdSec(decisions), enrichment)) as client:
        resp = await client.get("/api/v1/crowdsec/decisions")

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    first, second = body["items"]
    assert first["ip"] == "1.2.3.4"
    assert first["country_code"] == "NO"
    assert first["city"] == "Oslo"
    assert first["request_count_24h"] == 7
    assert second["ip"] == "10.0.0.0/24"
    assert second["scope"] == "Range"
    assert second["country_code"] is None
    assert second["request_count_24h"] is None
    # Only Ip-scope values ever reach the enrichment query
    assert enrichment.calls == [["1.2.3.4"]]


async def test_decisions_default_origins_excludes_capi():
    service = FakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        await client.get("/api/v1/crowdsec/decisions")
    assert service.calls == [{"origins": "crowdsec,cscli,geometrikks"}]


async def test_decisions_origins_override():
    service = FakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        await client.get("/api/v1/crowdsec/decisions", params={"origins": "CAPI"})
    assert service.calls == [{"origins": "CAPI"}]


async def test_decisions_pagination_slices_after_fetch():
    decisions = [make_decision(id=i, value=f"10.0.0.{i}") for i in range(5)]
    async with AsyncTestClient(app=make_app(FakeCrowdSec(decisions))) as client:
        resp = await client.get(
            "/api/v1/crowdsec/decisions",
            params={"currentPage": 2, "pageSize": 2},
        )
    body = resp.json()
    assert body["total"] == 5
    assert body["limit"] == 2
    assert body["offset"] == 2
    assert [item["ip"] for item in body["items"]] == ["10.0.0.2", "10.0.0.3"]


async def test_lookup_returns_decisions_for_ip():
    decisions = [
        make_decision(id=1, value="1.2.3.4"),
        make_decision(id=2, value="5.6.7.8"),
    ]
    async with AsyncTestClient(app=make_app(FakeCrowdSec(decisions))) as client:
        resp = await client.get(
            "/api/v1/crowdsec/decisions/lookup", params={"ip": "5.6.7.8"}
        )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["ip"] == "5.6.7.8"


async def test_stats_counts_by_origin_and_scenario():
    decisions = [
        make_decision(id=1, origin="crowdsec", scenario="crowdsecurity/ssh-bf"),
        make_decision(id=2, origin="crowdsec", scenario="crowdsecurity/ssh-bf"),
        make_decision(id=3, origin="cscli", scenario="manual ban"),
    ]
    service = FakeCrowdSec(decisions)
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/stats")

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert {"origin": "crowdsec", "count": 2} in body["by_origin"]
    assert {"origin": "cscli", "count": 1} in body["by_origin"]
    assert body["top_scenarios"][0] == {
        "scenario": "crowdsecurity/ssh-bf",
        "count": 2,
    }
    # Stats cover all origins, so no origins filter is applied
    assert service.calls == [{}]


# -- write endpoints + banned-ips ------------------------------------------


class WritableFakeCrowdSec(FakeCrowdSec):
    def __init__(self, decisions: list[Decision] | None = None) -> None:
        super().__init__(decisions or [])
        self.bans: list[tuple[str, str | None, str]] = []
        self.unbans: list[str] = []

    async def ban_ip(self, ip, *, duration=None, reason="manual ban from GeoMetrikks"):
        self.bans.append((ip, duration, reason))

    async def unban_ip(self, ip):
        self.unbans.append(ip)
        return 2


def enable_write(monkeypatch):
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    monkeypatch.setenv("CROWDSEC_MACHINE_ID", "geometrikks")
    monkeypatch.setenv("CROWDSEC_MACHINE_PASSWORD", "pass")


async def test_ban_requires_write_enabled(monkeypatch, tmp_path):
    # chdir away from the repo so a local .env with machine creds can't leak in
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    monkeypatch.delenv("CROWDSEC_MACHINE_ID", raising=False)
    monkeypatch.delenv("CROWDSEC_MACHINE_PASSWORD", raising=False)
    async with AsyncTestClient(app=make_app(WritableFakeCrowdSec())) as client:
        resp = await client.post("/api/v1/crowdsec/ban", json={"ip": "1.2.3.4"})
    assert resp.status_code == 403


async def test_ban_404_when_disabled():
    async with AsyncTestClient(app=make_app(None)) as client:
        assert (await client.post("/api/v1/crowdsec/ban", json={"ip": "1.2.3.4"})).status_code == 404
        assert (await client.post("/api/v1/crowdsec/unban", json={"ip": "1.2.3.4"})).status_code == 404
        assert (await client.get("/api/v1/crowdsec/banned-ips")).status_code == 404


async def test_ban_calls_service_with_duration_and_reason(monkeypatch):
    enable_write(monkeypatch)
    service = WritableFakeCrowdSec()
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.post(
            "/api/v1/crowdsec/ban",
            json={"ip": "1.2.3.4", "duration": "24h", "reason": "scanner"},
        )
    assert resp.status_code == 204
    assert service.bans == [("1.2.3.4", "24h", "scanner")]


async def test_ban_rejects_invalid_ip(monkeypatch):
    enable_write(monkeypatch)
    async with AsyncTestClient(app=make_app(WritableFakeCrowdSec())) as client:
        resp = await client.post("/api/v1/crowdsec/ban", json={"ip": "not-an-ip"})
    assert resp.status_code == 400


async def test_ban_rejects_invalid_duration(monkeypatch):
    enable_write(monkeypatch)
    async with AsyncTestClient(app=make_app(WritableFakeCrowdSec())) as client:
        resp = await client.post(
            "/api/v1/crowdsec/ban", json={"ip": "1.2.3.4", "duration": "4 hours"}
        )
    assert resp.status_code == 400


async def test_unban_returns_deleted_count(monkeypatch):
    enable_write(monkeypatch)
    service = WritableFakeCrowdSec()
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.post("/api/v1/crowdsec/unban", json={"ip": "5.6.7.8"})
    assert resp.status_code == 200
    assert resp.json() == {"deleted": 2}
    assert service.unbans == ["5.6.7.8"]


async def test_ban_is_audit_logged(monkeypatch):
    """A handler on the module logger, not caplog: Litestar's dictConfig
    replaces root handlers at app construction, silently dropping pytest's
    root-level capture handler."""
    enable_write(monkeypatch)
    import logging

    records: list[logging.LogRecord] = []

    class ListHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    audit_logger = logging.getLogger("geometrikks.api.v1.crowdsec_controller")
    handler = ListHandler(level=logging.INFO)
    app = make_app(WritableFakeCrowdSec())
    async with AsyncTestClient(app=app) as client:
        audit_logger.addHandler(handler)
        try:
            resp = await client.post(
                "/api/v1/crowdsec/ban", json={"ip": "1.2.3.4", "reason": "scanner"}
            )
        finally:
            audit_logger.removeHandler(handler)
    assert resp.status_code == 204, resp.text
    audit = [r.getMessage() for r in records if "1.2.3.4" in r.getMessage()]
    assert audit and "scanner" in audit[0]


async def test_banned_ips_returns_ip_scope_values_across_origins():
    decisions = [
        make_decision(id=1, value="1.2.3.4", origin="CAPI"),
        make_decision(id=2, value="5.6.7.8", origin="cscli"),
        make_decision(id=3, value="10.0.0.0/24", scope="Range", origin="crowdsec"),
    ]
    service = FakeCrowdSec(decisions)
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/banned-ips")
    assert resp.status_code == 200
    assert resp.json() == ["1.2.3.4", "5.6.7.8"]
    # one unfiltered fetch: all origins, so CAPI bans badge too
    assert service.calls == [{}]


async def test_lookup_rejects_invalid_ip():
    service = FakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get(
            "/api/v1/crowdsec/decisions/lookup", params={"ip": "not-an-ip"}
        )
    assert resp.status_code == 400
    # never forwarded to the LAPI
    assert service.calls == []


async def test_banned_ips_deduplicates_repeat_offenders():
    decisions = [
        make_decision(id=1, value="1.2.3.4", origin="CAPI"),
        make_decision(id=2, value="1.2.3.4", origin="crowdsec", scenario="ssh-bf"),
        make_decision(id=3, value="5.6.7.8", origin="cscli"),
    ]
    async with AsyncTestClient(app=make_app(FakeCrowdSec(decisions))) as client:
        resp = await client.get("/api/v1/crowdsec/banned-ips")
    assert resp.json() == ["1.2.3.4", "5.6.7.8"]


# -- alert history ---------------------------------------------------------


class AlertFakeCrowdSec(WritableFakeCrowdSec):
    def __init__(self, alerts=None) -> None:
        super().__init__()
        self._alerts = alerts or []
        self.alert_calls: list[dict] = []

    async def get_alerts(self, **filters):
        self.alert_calls.append(filters)
        return self._alerts


def make_alert():
    from geometrikks.services.crowdsec.schemas import Alert, AlertSource

    return Alert(
        id=7,
        scenario="crowdsecurity/ssh-bf",
        message="Ip 1.2.3.4 performed ssh bruteforce",
        events_count=6,
        created_at="2026-07-20T10:00:00Z",
        machine_id="gateway",
        source=AlertSource(scope="Ip", value="1.2.3.4", ip="1.2.3.4", cn="NO", as_name="Telenor"),
        decisions=[make_decision(id=9, origin="crowdsec", scenario="crowdsecurity/ssh-bf")],
    )


async def test_alerts_404_when_disabled():
    async with AsyncTestClient(app=make_app(None)) as client:
        assert (await client.get("/api/v1/crowdsec/alerts")).status_code == 404


async def test_alerts_403_without_machine_credentials(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec())) as client:
        assert (await client.get("/api/v1/crowdsec/alerts")).status_code == 403


async def test_alerts_returns_flattened_views(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([make_alert()])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get(
            "/api/v1/crowdsec/alerts", params={"limit": 25, "since": "24h"}
        )
    assert resp.status_code == 200
    (alert,) = resp.json()
    assert alert["scenario"] == "crowdsecurity/ssh-bf"
    assert alert["value"] == "1.2.3.4"
    assert alert["country"] == "NO"
    assert alert["as_name"] == "Telenor"
    assert alert["machine_id"] == "gateway"
    assert alert["events_count"] == 6
    assert alert["decision_count"] == 1
    assert service.alert_calls == [{"limit": 25, "ip": None, "scenario": None, "since": "24h"}]


async def test_alerts_without_lapi_geo_fall_back_to_own_enrichment(monkeypatch):
    """Manual bans carry no LAPI geo (cn/as_name are null); the endpoint
    fills country from GeoMetrikks' own stored traffic instead."""
    from geometrikks.services.crowdsec.schemas import AlertSource

    enable_write(monkeypatch)
    bare = make_alert()
    bare.source = AlertSource(scope="Ip", value="1.2.3.4", ip="1.2.3.4")
    enrichment = FakeEnrichment({"1.2.3.4": OSLO})
    service = AlertFakeCrowdSec([bare])
    async with AsyncTestClient(app=make_app(service, enrichment)) as client:
        resp = await client.get("/api/v1/crowdsec/alerts")
    (alert,) = resp.json()
    assert alert["country"] == "Norway"
    assert enrichment.calls == [["1.2.3.4"]]


# -- banned locations (map overlay) ----------------------------------------


class LocationsFakeEnrichment(FakeEnrichment):
    def __init__(self, locations) -> None:
        super().__init__({})
        self._locations = locations
        self.location_calls: list[list[str]] = []
        self.location_windows: list[tuple] = []

    async def locations(self, ips, *, start=None, end=None):
        self.location_calls.append(ips)
        self.location_windows.append((start, end))
        return [loc for loc in self._locations if loc.ip in ips]


async def test_banned_locations_join_banned_ips_with_geo():
    from geometrikks.domain.security.schemas import IpLocation

    decisions = [
        make_decision(id=1, value="1.2.3.4", origin="CAPI"),
        make_decision(id=2, value="9.9.9.9", origin="cscli"),
        make_decision(id=3, value="10.0.0.0/24", scope="Range"),
    ]
    oslo = IpLocation(ip="1.2.3.4", latitude=59.91, longitude=10.79, city="Oslo", country_code="NO")
    enrichment = LocationsFakeEnrichment([oslo])
    service = FakeCrowdSec(decisions)
    async with AsyncTestClient(app=make_app(service, enrichment)) as client:
        resp = await client.get("/api/v1/crowdsec/banned-locations")

    assert resp.status_code == 200
    (loc,) = resp.json()
    assert loc == {"ip": "1.2.3.4", "latitude": 59.91, "longitude": 10.79,
                   "city": "Oslo", "country_code": "NO"}
    # All origins queried; only Ip-scope values reach the geo join
    assert service.calls == [{}]
    assert enrichment.location_calls == [["1.2.3.4", "9.9.9.9"]]


async def test_banned_locations_deduplicates_ips_before_geo_join():
    decisions = [
        make_decision(id=1, value="1.2.3.4", origin="CAPI"),
        make_decision(id=2, value="1.2.3.4", origin="crowdsec", scenario="ssh-bf"),
        make_decision(id=3, value="9.9.9.9", origin="cscli"),
    ]
    enrichment = LocationsFakeEnrichment([])
    async with AsyncTestClient(app=make_app(FakeCrowdSec(decisions), enrichment)) as client:
        resp = await client.get("/api/v1/crowdsec/banned-locations")
    assert resp.status_code == 200
    assert enrichment.location_calls == [["1.2.3.4", "9.9.9.9"]]


async def test_banned_locations_forwards_time_window():
    from datetime import datetime, timezone

    enrichment = LocationsFakeEnrichment([])
    service = FakeCrowdSec([make_decision(id=1, value="1.2.3.4")])
    async with AsyncTestClient(app=make_app(service, enrichment)) as client:
        resp = await client.get(
            "/api/v1/crowdsec/banned-locations",
            params={
                "from_timestamp": "2026-07-01T00:00:00Z",
                "to_timestamp": "2026-07-02T00:00:00Z",
            },
        )
    assert resp.status_code == 200
    assert enrichment.location_windows == [
        (
            datetime(2026, 7, 1, tzinfo=timezone.utc),
            datetime(2026, 7, 2, tzinfo=timezone.utc),
        )
    ]


async def test_banned_locations_defaults_to_no_window():
    enrichment = LocationsFakeEnrichment([])
    service = FakeCrowdSec([make_decision(id=1, value="1.2.3.4")])
    async with AsyncTestClient(app=make_app(service, enrichment)) as client:
        await client.get("/api/v1/crowdsec/banned-locations")
    assert enrichment.location_windows == [(None, None)]


async def test_banned_locations_404_when_disabled():
    async with AsyncTestClient(app=make_app(None)) as client:
        assert (await client.get("/api/v1/crowdsec/banned-locations")).status_code == 404


# -- poller state fallback --------------------------------------------------


class StubPoller:
    def __init__(self, lapi_reachable: bool | None) -> None:
        self.lapi_reachable = lapi_reachable


class PingBomb(FakeCrowdSec):
    async def ping(self) -> bool:
        raise AssertionError("ping must not be called when poller state exists")


async def test_status_uses_poller_state_without_ping(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    app = make_app(PingBomb([]))
    app.state.crowdsec_stream_poller = StubPoller(lapi_reachable=False)
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/crowdsec/status")
    assert resp.json()["lapi_reachable"] is False


async def test_status_falls_back_to_ping_before_first_poll(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    app = make_app(FakeCrowdSec([], reachable=True))
    app.state.crowdsec_stream_poller = StubPoller(lapi_reachable=None)
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/crowdsec/status")
    assert resp.json()["lapi_reachable"] is True
