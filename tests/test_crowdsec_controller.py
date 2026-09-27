"""CrowdSec API: status, decisions (paginated + enriched), lookup, stats."""
from __future__ import annotations

from typing import Any

from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient

from geometrikks.domain.security.controllers import CrowdSecController
from geometrikks.server.exceptions import EXCEPTION_HANDLERS
from geometrikks.domain.security.repositories import SecurityEnrichmentRepository
from geometrikks.domain.security.schemas import IpEnrichment
from geometrikks.services.crowdsec import CrowdSecService, Decision
from geometrikks.server.routes import create_api_v1_router
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
        route_handlers=[create_api_v1_router([_TestController])],
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
        "writeEnabled": False,
        "lapiReachable": False,
        "liveUpdates": False,
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
        "writeEnabled": False,
        "lapiReachable": True,
        "liveUpdates": False,
    }


async def test_status_write_enabled(monkeypatch):
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    monkeypatch.setenv("CROWDSEC_MACHINE_ID", "geometrikks")
    monkeypatch.setenv("CROWDSEC_MACHINE_PASSWORD", "pass")
    async with AsyncTestClient(app=make_app(FakeCrowdSec([]))) as client:
        resp = await client.get("/api/v1/crowdsec/status")
    assert resp.json()["writeEnabled"] is True


async def test_status_reports_unreachable_lapi():
    async with AsyncTestClient(
        app=make_app(FakeCrowdSec([], reachable=False))
    ) as client:
        resp = await client.get("/api/v1/crowdsec/status")
    assert resp.json()["lapiReachable"] is False


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
    assert first["countryCode"] == "NO"
    assert first["city"] == "Oslo"
    assert first["requestCount24h"] == 7
    assert second["ip"] == "10.0.0.0/24"
    assert second["scope"] == "Range"
    assert second["countryCode"] is None
    assert second["requestCount24h"] is None
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


async def test_decisions_group_by_ip_and_count_ips_in_total():
    decisions = [
        make_decision(id=1, value="1.2.3.4", duration="1h49m36s", scenario="crowdsecurity/http-sensitive-files"),
        make_decision(id=2, value="1.2.3.4", duration="1h50m33s", scenario="crowdsecurity/http-probing", type="captcha"),
        make_decision(id=3, value="5.6.7.8", duration="30m", origin="crowdsec"),
    ]
    enrichment = FakeEnrichment({"1.2.3.4": OSLO})
    async with AsyncTestClient(app=make_app(FakeCrowdSec(decisions), enrichment)) as client:
        body = (await client.get("/api/v1/crowdsec/decisions")).json()

    assert body["total"] == 2
    first, second = body["items"]
    assert (first["ip"], first["decisionCount"], first["duration"]) == ("1.2.3.4", 2, "1h50m33s")
    assert first["type"] == "ban"
    assert first["countryCode"] == "NO"
    assert [(d["id"], d["scenario"], d["duration"]) for d in first["decisions"]] == [
        (2, "crowdsecurity/http-probing", "1h50m33s"),
        (1, "crowdsecurity/http-sensitive-files", "1h49m36s"),
    ]
    assert (second["ip"], second["decisionCount"], second["origins"]) == ("5.6.7.8", 1, ["crowdsec"])
    # One enrichment lookup per IP, not per decision
    assert enrichment.calls == [["1.2.3.4", "5.6.7.8"]]


async def test_decisions_pagination_pages_over_ips_not_decisions():
    decisions = [
        make_decision(id=i * 10 + n, value=f"10.0.0.{i}", duration=f"{n + 1}h")
        for i in range(3)
        for n in range(2)
    ]
    async with AsyncTestClient(app=make_app(FakeCrowdSec(decisions))) as client:
        body = (
            await client.get("/api/v1/crowdsec/decisions", params={"currentPage": 2, "pageSize": 2})
        ).json()
    assert body["total"] == 3
    assert [item["ip"] for item in body["items"]] == ["10.0.0.2"]


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
    assert {"origin": "crowdsec", "count": 2} in body["byOrigin"]
    assert {"origin": "cscli", "count": 1} in body["byOrigin"]
    assert body["topScenarios"][0] == {
        "scenario": "crowdsecurity/ssh-bf",
        "count": 2,
    }
    # Stats cover all origins, so no origins filter is applied
    assert service.calls == [{}]


# -- write endpoints + banned-ips ------------------------------------------


class WritableFakeCrowdSec(FakeCrowdSec):
    def __init__(self, decisions: list[Decision] | None = None) -> None:
        super().__init__(decisions or [])
        self.bans: list[dict] = []
        self.unbans: list[tuple[str, str]] = []

    async def ban(self, value, *, scope="Ip", decision_type="ban", duration=None, reason=None):
        self.bans.append({
            "value": value, "scope": scope, "type": decision_type,
            "duration": duration, "reason": reason,
        })

    async def unban(self, value, *, scope="Ip"):
        self.unbans.append((value, scope))
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
    assert service.bans == [{
        "value": "1.2.3.4", "scope": "Ip", "type": "ban", "duration": "24h", "reason": "scanner",
    }]


async def post_ban(monkeypatch, body: dict) -> tuple[int, WritableFakeCrowdSec]:
    enable_write(monkeypatch)
    service = WritableFakeCrowdSec()
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.post("/api/v1/crowdsec/ban", json=body)
    return resp.status_code, service


async def test_ban_cidr_becomes_normalized_range(monkeypatch):
    status, service = await post_ban(monkeypatch, {"ip": "10.0.0.5/24"})
    assert status == 204
    assert (service.bans[0]["value"], service.bans[0]["scope"]) == ("10.0.0.0/24", "Range")


@pytest.mark.parametrize(("cidr", "ip"), [("10.0.0.5/32", "10.0.0.5"), ("2001:db8::1/128", "2001:db8::1")])
async def test_ban_single_address_cidr_is_an_ip_ban(monkeypatch, cidr, ip):
    status, service = await post_ban(monkeypatch, {"ip": cidr})
    assert status == 204
    assert (service.bans[0]["value"], service.bans[0]["scope"]) == (ip, "Ip")


@pytest.mark.parametrize("value", ["0.0.0.0/0", "::/0", "10.0.0.0/33", "10.0.0/8"])
async def test_ban_rejects_bad_ranges(monkeypatch, value):
    status, service = await post_ban(monkeypatch, {"ip": value})
    assert status == 400
    assert service.bans == []


async def test_ban_passes_captcha_type(monkeypatch):
    status, service = await post_ban(monkeypatch, {"ip": "1.2.3.4", "type": "captcha"})
    assert status == 204
    assert service.bans[0]["type"] == "captcha"


async def test_ban_default_reason_names_the_decision_type(monkeypatch):
    status, service = await post_ban(monkeypatch, {"ip": "1.2.3.4", "type": "captcha"})
    assert status == 204
    assert service.bans[0]["reason"] == "manual captcha from GeoMetrikks"


async def test_ban_rejects_unknown_type(monkeypatch):
    status, service = await post_ban(monkeypatch, {"ip": "1.2.3.4", "type": "throttle"})
    assert status == 400
    assert service.bans == []


@pytest.mark.parametrize(
    ("given", "sent"),
    [("3d", "72h"), ("2d12h", "60h"), ("1d30m", "24h30m"), ("90m", "90m"), ("1h30m", "1h30m")],
)
async def test_ban_converts_days_to_hours(monkeypatch, given, sent):
    status, service = await post_ban(monkeypatch, {"ip": "1.2.3.4", "duration": given})
    assert status == 204
    assert service.bans[0]["duration"] == sent


@pytest.mark.parametrize("duration", ["0h", "0d0m", "d", "4 hours", "1w"])
async def test_ban_rejects_empty_or_malformed_durations(monkeypatch, duration):
    status, service = await post_ban(monkeypatch, {"ip": "1.2.3.4", "duration": duration})
    assert status == 400
    assert service.bans == []


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
    assert service.unbans == [("5.6.7.8", "Ip")]


async def test_unban_cidr_targets_the_normalized_range(monkeypatch):
    enable_write(monkeypatch)
    service = WritableFakeCrowdSec()
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.post("/api/v1/crowdsec/unban", json={"ip": "10.0.0.7/24"})
    assert resp.status_code == 200
    assert service.unbans == [("10.0.0.0/24", "Range")]


async def test_ban_is_audit_logged(monkeypatch):
    import structlog

    enable_write(monkeypatch)
    async with AsyncTestClient(app=make_app(WritableFakeCrowdSec())) as client:
        with structlog.testing.capture_logs() as captured:
            resp = await client.post(
                "/api/v1/crowdsec/ban",
                json={"ip": "1.2.3.4", "reason": "scanner", "type": "captcha"},
            )
    assert resp.status_code == 204, resp.text
    (audit,) = [e for e in captured if e["event"].startswith("CrowdSec ban by")]
    assert audit["positional_args"] == ("unknown", "1.2.3.4", "Ip", "captcha", "4h", "scanner")


async def test_banned_ips_returns_ip_scope_entries_with_type_across_origins():
    decisions = [
        make_decision(id=1, value="1.2.3.4", origin="CAPI"),
        make_decision(id=2, value="5.6.7.8", origin="crowdsec", type="captcha"),
        make_decision(id=3, value="10.0.0.0/24", scope="Range", origin="crowdsec"),
    ]
    service = FakeCrowdSec(decisions)
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/banned-ips")
    assert resp.status_code == 200
    assert resp.json() == [
        {"ip": "1.2.3.4", "type": "ban"},
        {"ip": "5.6.7.8", "type": "captcha"},
    ]
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


async def test_banned_ips_keeps_one_entry_per_ip_and_ban_wins():
    decisions = [
        make_decision(id=1, value="1.2.3.4", origin="crowdsec", type="captcha"),
        make_decision(id=2, value="1.2.3.4", origin="CAPI", type="ban"),
        make_decision(id=3, value="5.6.7.8", origin="cscli", type="throttle"),
        make_decision(id=4, value="5.6.7.8", origin="crowdsec", type="captcha"),
    ]
    async with AsyncTestClient(app=make_app(FakeCrowdSec(decisions))) as client:
        resp = await client.get("/api/v1/crowdsec/banned-ips")
    assert resp.json() == [
        {"ip": "1.2.3.4", "type": "ban"},
        {"ip": "5.6.7.8", "type": "captcha"},
    ]


async def test_banned_ips_canonicalizes_addresses_and_skips_non_ips():
    decisions = [
        make_decision(id=1, value="2001:0db8::1", origin="crowdsec", type="captcha"),
        make_decision(id=2, value="2001:db8::1", origin="CAPI", type="ban"),
        make_decision(id=3, value="not-an-ip", origin="cscli"),
    ]
    async with AsyncTestClient(app=make_app(FakeCrowdSec(decisions))) as client:
        resp = await client.get("/api/v1/crowdsec/banned-ips")
    assert resp.json() == [{"ip": "2001:db8::1", "type": "ban"}]


# -- alert history ---------------------------------------------------------


class AlertFakeCrowdSec(WritableFakeCrowdSec):
    def __init__(self, alerts=None) -> None:
        super().__init__()
        self._alerts = alerts or []
        self.alert_calls: list[dict] = []

    async def get_alerts(self, **filters):
        self.alert_calls.append(filters)
        return self._alerts

    async def get_alert(self, alert_id):
        return next((a for a in self._alerts if a.id == alert_id), None)


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
    assert (alert["countryCode"], alert["countryName"]) == ("NO", None)
    assert alert["asName"] == "Telenor"
    assert alert["machineId"] == "gateway"
    assert alert["eventsCount"] == 6
    assert alert["decisionCount"] == 1
    assert service.alert_calls == [
        {"limit": 25, "ip": None, "scenario": None, "since": "24h", "kind": None, "has_active_decision": None}
    ]


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
    assert (alert["countryCode"], alert["countryName"]) == ("NO", "Norway")
    assert enrichment.calls == [["1.2.3.4"]]


async def test_alerts_count_active_decisions_apart_from_expired(monkeypatch):
    enable_write(monkeypatch)
    alert = make_alert()
    alert.decisions.append(make_decision(id=10, duration="-2h5m"))
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec([alert]))) as client:
        (view,) = (await client.get("/api/v1/crowdsec/alerts")).json()
    assert (view["decisionCount"], view["activeDecisionCount"]) == (2, 1)



async def test_alerts_report_their_kind(monkeypatch):
    enable_write(monkeypatch)
    rejection = make_alert()
    rejection.id = 8
    rejection.kind = "bot-detection"
    rejection.decisions = []
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec([make_alert(), rejection]))) as client:
        views = (await client.get("/api/v1/crowdsec/alerts")).json()
    assert [v["kind"] for v in views] == [None, "bot-detection"]


async def test_alerts_forward_kind_and_live_decision_filters(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get(
            "/api/v1/crowdsec/alerts", params={"kind": "bot-detection", "hasActiveDecision": "true"}
        )
    assert resp.status_code == 200
    (call,) = service.alert_calls
    assert call["kind"] == "bot-detection"
    assert call["has_active_decision"] is True


async def test_alerts_reject_an_unknown_kind(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/alerts", params={"kind": "robot"})
    assert resp.status_code == 400
    assert service.alert_calls == []


# -- alert detail ----------------------------------------------------------


def make_detailed_alert():
    from geometrikks.services.crowdsec.schemas import AlertContext, AlertEvent

    alert = make_alert()
    alert.kind = "crowdsec"
    alert.simulated = False
    alert.start_at = "2026-07-20T09:59:50Z"
    alert.stop_at = "2026-07-20T10:00:00Z"
    alert.source.as_number = "2119"
    alert.source.range = "1.2.3.0/24"
    alert.context = [AlertContext(key="target_uri", values=["/wp-login.php", "/.env"])]
    alert.events = [
        AlertEvent(
            timestamp="2026-07-20T09:59:50Z",
            meta={"http_path": "/.env", "http_status": "404", "http_verb": "GET"},
        )
    ]
    alert.decisions.append(make_decision(id=10, duration="-2h5m"))
    return alert


async def test_alert_detail_404_when_disabled():
    async with AsyncTestClient(app=make_app(None)) as client:
        assert (await client.get("/api/v1/crowdsec/alerts/7")).status_code == 404


async def test_alert_detail_403_without_machine_credentials(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec())) as client:
        assert (await client.get("/api/v1/crowdsec/alerts/7")).status_code == 403


async def test_alert_detail_404_for_unknown_alert(monkeypatch):
    enable_write(monkeypatch)
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec([make_alert()]))) as client:
        assert (await client.get("/api/v1/crowdsec/alerts/999")).status_code == 404


async def test_alert_detail_returns_context_events_and_decisions(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([make_detailed_alert()])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/alerts/7")
    assert resp.status_code == 200
    detail = resp.json()
    assert detail["kind"] == "crowdsec"
    assert detail["simulated"] is False
    assert (detail["startAt"], detail["stopAt"]) == ("2026-07-20T09:59:50Z", "2026-07-20T10:00:00Z")
    assert (detail["countryCode"], detail["asName"], detail["asNumber"]) == ("NO", "Telenor", "2119")
    assert detail["range"] == "1.2.3.0/24"
    assert detail["eventsCount"] == 6
    assert detail["context"] == [{"key": "target_uri", "values": ["/wp-login.php", "/.env"]}]
    assert detail["events"] == [
        {
            "timestamp": "2026-07-20T09:59:50Z",
            "meta": {"http_path": "/.env", "http_status": "404", "http_verb": "GET"},
        }
    ]
    assert [(d["id"], d["expired"]) for d in detail["decisions"]] == [(9, False), (10, True)]


async def test_alert_detail_without_lapi_geo_falls_back_to_own_enrichment(monkeypatch):
    from geometrikks.services.crowdsec.schemas import AlertSource

    enable_write(monkeypatch)
    bare = make_alert()
    bare.source = AlertSource(scope="Ip", value="1.2.3.4", ip="1.2.3.4")
    service = AlertFakeCrowdSec([bare])
    async with AsyncTestClient(app=make_app(service, FakeEnrichment({"1.2.3.4": OSLO}))) as client:
        detail = (await client.get("/api/v1/crowdsec/alerts/7")).json()
    assert (detail["countryCode"], detail["countryName"]) == ("NO", "Norway")


# -- the alert behind a decision -------------------------------------------


async def test_decision_alert_returns_the_alert_holding_that_decision(monkeypatch):
    enable_write(monkeypatch)
    older = make_detailed_alert()
    older.id = 6
    older.decisions = [make_decision(id=4, duration="5h")]
    service = AlertFakeCrowdSec([make_detailed_alert(), older])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/decisions/4/alert", params={"ip": "1.2.3.4"})
    assert resp.status_code == 200
    assert resp.json()["id"] == 6
    assert resp.json()["context"] == [{"key": "target_uri", "values": ["/wp-login.php", "/.env"]}]
    # The common case is one call: the alert is among the IP's live ones.
    assert service.alert_calls == [
        {"limit": 0, "ip": "1.2.3.4", "scenario": None, "since": None, "has_active_decision": True}
    ]


async def test_decision_alert_404_when_no_alert_holds_the_decision(monkeypatch):
    enable_write(monkeypatch)
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec([make_alert()]))) as client:
        resp = await client.get("/api/v1/crowdsec/decisions/999/alert", params={"ip": "1.2.3.4"})
    assert resp.status_code == 404


async def test_decision_alert_rejects_invalid_ip(monkeypatch):
    enable_write(monkeypatch)
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec())) as client:
        resp = await client.get("/api/v1/crowdsec/decisions/4/alert", params={"ip": "nope"})
    assert resp.status_code == 400


async def test_decision_alert_403_without_machine_credentials(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec())) as client:
        resp = await client.get("/api/v1/crowdsec/decisions/4/alert", params={"ip": "1.2.3.4"})
    assert resp.status_code == 403
async def test_alert_geo_fallback_finds_a_non_canonical_ipv6_source(monkeypatch):
    """Enrichment rows are keyed by the canonical address text."""
    from geometrikks.services.crowdsec.schemas import AlertSource

    enable_write(monkeypatch)
    spelled_out = "2001:0db8:0000:0000:0000:0000:0000:0001"
    bare = make_alert()
    bare.source = AlertSource(scope="Ip", value=spelled_out, ip=spelled_out)
    enrichment = FakeEnrichment({"2001:db8::1": OSLO})
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec([bare]), enrichment)) as client:
        (listed,) = (await client.get("/api/v1/crowdsec/alerts")).json()
        detail = (await client.get("/api/v1/crowdsec/alerts/7")).json()
    assert (listed["countryName"], detail["countryName"]) == ("Norway", "Norway")
    assert listed["value"] == detail["value"] == "2001:db8::1"


@pytest.mark.parametrize("scope", ["Range", "Username"])
async def test_alert_non_ip_source_value_is_preserved(monkeypatch, scope):
    from geometrikks.services.crowdsec.schemas import AlertSource

    enable_write(monkeypatch)
    value = "2001:0db8::1"
    alert = make_alert()
    alert.source = AlertSource(scope=scope, value=value)
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec([alert]))) as client:
        (listed,) = (await client.get("/api/v1/crowdsec/alerts")).json()
        detail = (await client.get("/api/v1/crowdsec/alerts/7")).json()
    assert listed["value"] == detail["value"] == value


def test_alert_detail_documents_its_404():
    schema = make_app(None).openapi_schema.to_schema()
    responses = schema["paths"]["/api/v1/crowdsec/alerts/{alert_id}"]["get"]["responses"]
    assert "404" in responses


class FilteringAlertFake(AlertFakeCrowdSec):
    """Applies the LAPI's ``has_active_decision`` and ``limit`` filters."""

    async def get_alerts(self, **filters):
        self.alert_calls.append(filters)
        alerts = self._alerts
        if filters.get("has_active_decision"):
            alerts = [a for a in alerts if any(not d.expired for d in a.decisions)]
        limit = filters.get("limit")
        return alerts[:limit] if limit else alerts


async def test_decision_alert_survives_the_decision_expiring_after_the_table_loaded(monkeypatch):
    enable_write(monkeypatch)
    alert = make_detailed_alert()
    alert.decisions = [make_decision(id=4, duration="-1s")]
    service = FilteringAlertFake([alert])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/decisions/4/alert", params={"ip": "1.2.3.4"})
    assert resp.status_code == 200
    assert [call.get("has_active_decision") for call in service.alert_calls] == [True, None]


async def test_decision_alert_is_found_behind_a_hundred_other_live_alerts(monkeypatch):
    enable_write(monkeypatch)
    alerts = []
    for number in range(101):
        alert = make_alert()
        alert.id = 1000 + number
        alert.decisions = [make_decision(id=number, duration="4h")]
        alerts.append(alert)
    async with AsyncTestClient(app=make_app(FilteringAlertFake(alerts))) as client:
        resp = await client.get("/api/v1/crowdsec/decisions/100/alert", params={"ip": "1.2.3.4"})
    assert resp.status_code == 200
    assert resp.json()["id"] == 1100


async def test_decision_alert_searches_retained_alerts_before_answering_404(monkeypatch):
    enable_write(monkeypatch)
    service = FilteringAlertFake([make_alert()])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/decisions/999/alert", params={"ip": "1.2.3.4"})
    assert resp.status_code == 404
    assert [call.get("has_active_decision") for call in service.alert_calls] == [True, None]


def test_decision_alert_documents_its_404():
    schema = make_app(None).openapi_schema.to_schema()
    path = schema["paths"]["/api/v1/crowdsec/decisions/{decision_id}/alert"]
    assert "404" in path["get"]["responses"]


# -- banned locations (map overlay) ----------------------------------------


class LocationsFakeEnrichment(FakeEnrichment):
    def __init__(self, locations) -> None:
        super().__init__({})
        self._locations = locations
        self.location_calls: list[list[str]] = []
        self.location_windows: list[tuple] = []

    async def locations(self, ips, *, start=None, end=None, **filters):
        self.location_calls.append(ips)
        self.location_windows.append((start, end))
        self.location_filters = filters
        return [loc for loc in self._locations if loc.ip in ips]


async def test_banned_locations_join_banned_ips_with_geo():
    from geometrikks.domain.security.schemas import IpLocation

    decisions = [
        make_decision(id=1, value="1.2.3.4", origin="CAPI"),
        make_decision(id=2, value="9.9.9.9", origin="cscli"),
        make_decision(id=3, value="10.0.0.0/24", scope="Range"),
    ]
    oslo = IpLocation(ip="1.2.3.4", location_id=130, latitude=59.91, longitude=10.79, city="Oslo", country_code="NO", event_count=7)
    enrichment = LocationsFakeEnrichment([oslo])
    service = FakeCrowdSec(decisions)
    async with AsyncTestClient(app=make_app(service, enrichment)) as client:
        resp = await client.get("/api/v1/crowdsec/banned-locations")

    assert resp.status_code == 200
    body = resp.json()
    assert body["type"] == "FeatureCollection"
    assert body["stats"] == {"ips": 1, "locations": 1, "events": 7, "countries": 1, "cities": 1}
    (feature,) = body["features"]
    assert feature["geometry"] == {"type": "Point", "coordinates": [10.79, 59.91]}
    assert feature["properties"]["bannedIps"] == [
        {"ip": "1.2.3.4", "locationId": 130, "city": "Oslo", "countryCode": "NO", "eventCount": 7}
    ]
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
                "fromTimestamp": "2026-07-01T00:00:00Z",
                "toTimestamp": "2026-07-02T00:00:00Z",
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
    assert resp.json()["lapiReachable"] is False


async def test_status_falls_back_to_ping_before_first_poll(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    app = make_app(FakeCrowdSec([], reachable=True))
    app.state.crowdsec_stream_poller = StubPoller(lapi_reachable=None)
    async with AsyncTestClient(app=app) as client:
        resp = await client.get("/api/v1/crowdsec/status")
    assert resp.json()["lapiReachable"] is True


async def test_banned_map_keeps_every_ip_decision_normalizes_ips_and_forwards_filters():
    enrichment = LocationsFakeEnrichment([])
    service = FakeCrowdSec([
        make_decision(value="2001:0db8::1"), make_decision(value="2001:db8::1"),
        make_decision(value="1.2.3.4", type="captcha"),
        make_decision(value="not-an-ip"), make_decision(value="10.0.0.0/24", scope="Range"),
    ])
    async with AsyncTestClient(app=make_app(service, enrichment)) as client:
        response = await client.get("/api/v1/crowdsec/banned-locations", params={
            "countryCode": ["NO", "SE"], "city": ["Oslo"], "hostnameIn": ["a.test", "b.test"],
        })
    assert response.status_code == 200
    assert enrichment.location_calls == [["2001:db8::1", "1.2.3.4"]]
    assert enrichment.location_filters == {
        "country_codes": ["NO", "SE"], "cities": ["Oslo"], "hostnames": ["a.test", "b.test"],
    }
    assert response.json()["stats"] == {"ips": 0, "locations": 0, "events": 0, "countries": 0, "cities": 0}
