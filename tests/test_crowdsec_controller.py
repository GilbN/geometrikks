"""CrowdSec API: status, decisions (paginated + enriched), lookup, stats."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient

from geometrikks.domain.security.controllers import CrowdSecController
from geometrikks.server.exceptions import EXCEPTION_HANDLERS
from geometrikks.domain.security.repositories import SecurityEnrichmentRepository
from geometrikks.domain.security.schemas import IpEnrichment
from geometrikks.domain.drop.snapshot import EMPTY_DROP_SNAPSHOT, DropNetworkMatch, DropSnapshot, FeedState
from geometrikks.domain.security.repositories import DropTrafficRepository
from geometrikks.domain.security.schemas import DropNetworkHits, DropNetworkOrigin
from geometrikks.services.crowdsec import CrowdSecService, CrowdSecUnavailableError, Decision
from geometrikks.services.geoip.locator import GeoIpLocator, GeoIpPlace
from geometrikks.server.routes import create_api_v1_router
from tests.support import ambient_settings_dependency

import pytest
from structlog.testing import capture_logs

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


class SpyGeoIp(GeoIpLocator):
    def __init__(self) -> None:
        super().__init__(TEST_CITY_DB, ["en"])
        self.calls: list[list[str]] = []

    def locate(self, ips) -> dict[str, GeoIpPlace]:
        self.calls.append(list(ips))
        return super().locate(ips)


TEST_CITY_DB = "tests/GeoLite2-City-Test.mmdb"
# The test database places this IP in London.
LONDON_IP = "81.2.69.142"


def make_app(
    service: FakeCrowdSec | None,
    enrichment: FakeEnrichment | None = None,
    geoip: GeoIpLocator | None = None,
    *,
    real_geoip: bool = False,
    drop_snapshot: DropSnapshot = EMPTY_DROP_SNAPSHOT,
    drop_traffic: DropTrafficRepository | None = None,
) -> Litestar:
    enrichment = enrichment if enrichment is not None else FakeEnrichment({})
    overrides = {
        "enrichment_repo": Provide(lambda: enrichment, sync_to_thread=False),
        "drop_snapshot": Provide(lambda: drop_snapshot, sync_to_thread=False),
        "drop_traffic_repo": Provide(lambda: drop_traffic, sync_to_thread=False),
    }
    if not real_geoip:
        overrides["geoip"] = Provide(lambda: geoip, sync_to_thread=False)

    class _TestController(CrowdSecController):
        dependencies = {**(CrowdSecController.dependencies or {}), **overrides}

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


async def test_decisions_without_stored_traffic_fall_back_to_geoip():
    decisions = [
        make_decision(id=1, value="1.2.3.4"),
        make_decision(id=2, value=LONDON_IP, origin="crowdsec", scenario="crowdsecurity/postfix-spam"),
        make_decision(id=3, value="10.0.0.0/24", scope="Range", origin="crowdsec"),
    ]
    geoip = SpyGeoIp()
    app = make_app(FakeCrowdSec(decisions), FakeEnrichment({"1.2.3.4": OSLO}), geoip)
    async with AsyncTestClient(app=app) as client:
        stored, looked_up, cidr = (await client.get("/api/v1/crowdsec/decisions")).json()["items"]

    assert (stored["countryName"], stored["city"], stored["requestCount24h"]) == ("Norway", "Oslo", 7)
    assert (looked_up["countryCode"], looked_up["countryName"], looked_up["city"]) == (
        "GB", "United Kingdom", "London",
    )
    assert looked_up["requestCount24h"] == 0
    assert cidr["countryCode"] is None
    # GeoLite2 sees only the IP that stored traffic had no country for.
    assert geoip.calls == [[LONDON_IP]]


async def test_decisions_geoip_fills_stored_traffic_without_a_country():
    no_country = IpEnrichment(country_code=None, country_name=None, city=None, request_count_24h=3)
    app = make_app(
        FakeCrowdSec([make_decision(value=LONDON_IP)]), FakeEnrichment({LONDON_IP: no_country}), SpyGeoIp()
    )
    async with AsyncTestClient(app=app) as client:
        (item,) = (await client.get("/api/v1/crowdsec/decisions")).json()["items"]
    assert (item["countryCode"], item["requestCount24h"]) == ("GB", 3)


async def test_decisions_geoip_lookup_uses_the_configured_database(monkeypatch):
    monkeypatch.setenv("GEOIP_DB_PATH", TEST_CITY_DB)
    app = make_app(FakeCrowdSec([make_decision(value=LONDON_IP)]), real_geoip=True)
    app.state.geoip_available = True
    async with AsyncTestClient(app=app) as client:
        (item,) = (await client.get("/api/v1/crowdsec/decisions")).json()["items"]
    assert item["countryCode"] == "GB"


async def test_decisions_skip_geoip_in_geo_degraded_mode(monkeypatch):
    monkeypatch.setenv("GEOIP_DB_PATH", TEST_CITY_DB)
    app = make_app(FakeCrowdSec([make_decision(value=LONDON_IP)]), real_geoip=True)
    app.state.geoip_available = False
    async with AsyncTestClient(app=app) as client:
        (item,) = (await client.get("/api/v1/crowdsec/decisions")).json()["items"]
    assert item["countryCode"] is None


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


async def test_decisions_ip_search_reads_every_origin():
    decisions = [
        make_decision(id=1, value="45.148.10.80", origin="CAPI", scenario="crowdsecurity/http-probing"),
        make_decision(id=2, value="5.6.7.8"),
    ]
    service = FakeCrowdSec(decisions)
    async with AsyncTestClient(app=make_app(service)) as client:
        body = (await client.get("/api/v1/crowdsec/decisions", params={"q": "45.148.10.80"})).json()
    assert service.calls == [{}]
    assert body["total"] == 1
    assert [item["ip"] for item in body["items"]] == ["45.148.10.80"]


async def test_decisions_text_search_keeps_the_origin_tab_and_pages_the_matches():
    decisions = [
        make_decision(id=i, value=f"10.0.0.{i}", scenario="crowdsecurity/ssh-bf" if i % 2 else "crowdsecurity/http-probing")
        for i in range(6)
    ]
    service = FakeCrowdSec(decisions)
    async with AsyncTestClient(app=make_app(service)) as client:
        body = (
            await client.get(
                "/api/v1/crowdsec/decisions", params={"q": "ssh", "origins": "CAPI", "currentPage": 2, "pageSize": 2}
            )
        ).json()
    assert service.calls == [{"origins": "CAPI"}]
    assert body["total"] == 3
    assert [item["ip"] for item in body["items"]] == ["10.0.0.5"]


async def test_decisions_search_is_length_limited():
    async with AsyncTestClient(app=make_app(FakeCrowdSec([]))) as client:
        resp = await client.get("/api/v1/crowdsec/decisions", params={"q": "x" * 201})
    assert resp.status_code == 400


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
        limit = filters.get("limit")
        return self._alerts[:limit] if limit else self._alerts

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
    (alert,) = resp.json()["alerts"]
    assert alert["scenario"] == "crowdsecurity/ssh-bf"
    assert alert["value"] == "1.2.3.4"
    assert (alert["countryCode"], alert["countryName"]) == ("NO", None)
    assert alert["asName"] == "Telenor"
    assert alert["machineId"] == "gateway"
    assert alert["eventsCount"] == 6
    assert alert["decisionCount"] == 1
    assert service.alert_calls == [
        {
            "limit": 25, "created_before": None, "scenario": None, "since": "24h",
            "kind": None, "has_active_decision": None,
        }
    ]


async def test_alerts_list_distinct_decision_types(monkeypatch):
    enable_write(monkeypatch)
    mixed = make_alert()
    mixed.decisions = [
        make_decision(id=1, type="ban"),
        make_decision(id=2, type="ban"),
        make_decision(id=3, type="captcha"),
    ]
    alert_only = make_alert()
    alert_only.id = 8
    alert_only.decisions = []
    service = AlertFakeCrowdSec([mixed, alert_only])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/alerts")
    mixed_view, alert_only_view = resp.json()["alerts"]
    assert mixed_view["decisionTypes"] == ["ban", "captcha"]
    assert alert_only_view["decisionTypes"] == []


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
    (alert,) = resp.json()["alerts"]
    assert (alert["countryCode"], alert["countryName"]) == ("NO", "Norway")
    assert enrichment.calls == [["1.2.3.4"]]


def make_london_alert(cn: str):
    from geometrikks.services.crowdsec.schemas import AlertSource

    alert = make_alert()
    alert.source = AlertSource(scope="Ip", value=LONDON_IP, ip=LONDON_IP, cn=cn)
    return alert


async def test_alerts_name_the_lapi_country_code_from_geoip(monkeypatch):
    enable_write(monkeypatch)
    enrichment = FakeEnrichment({})
    service = AlertFakeCrowdSec([make_london_alert(cn="GB")])
    async with AsyncTestClient(app=make_app(service, enrichment, SpyGeoIp())) as client:
        (alert,) = (await client.get("/api/v1/crowdsec/alerts")).json()["alerts"]
    assert (alert["countryCode"], alert["countryName"]) == ("GB", "United Kingdom")
    # The LAPI already sent a code, so the endpoint skips the stored-traffic query.
    assert enrichment.calls == []


async def test_alerts_without_lapi_geo_or_stored_traffic_fall_back_to_geoip(monkeypatch):
    from geometrikks.services.crowdsec.schemas import AlertSource

    enable_write(monkeypatch)
    bare = make_alert()
    bare.source = AlertSource(scope="Ip", value=LONDON_IP, ip=LONDON_IP)
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec([bare]), geoip=SpyGeoIp())) as client:
        (alert,) = (await client.get("/api/v1/crowdsec/alerts")).json()["alerts"]
    assert (alert["countryCode"], alert["countryName"]) == ("GB", "United Kingdom")


async def test_alerts_count_active_decisions_apart_from_expired(monkeypatch):
    enable_write(monkeypatch)
    alert = make_alert()
    alert.decisions.append(make_decision(id=10, duration="-2h5m"))
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec([alert]))) as client:
        (view,) = (await client.get("/api/v1/crowdsec/alerts")).json()["alerts"]
    assert (view["decisionCount"], view["activeDecisionCount"]) == (2, 1)



async def test_alerts_report_their_kind(monkeypatch):
    enable_write(monkeypatch)
    rejection = make_alert()
    rejection.id = 8
    rejection.kind = "bot-detection"
    rejection.decisions = []
    async with AsyncTestClient(app=make_app(AlertFakeCrowdSec([make_alert(), rejection]))) as client:
        views = (await client.get("/api/v1/crowdsec/alerts")).json()["alerts"]
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


async def test_alerts_page_carries_next_cursor(monkeypatch):
    enable_write(monkeypatch)
    alerts = []
    for alert_id, minute in ((9, 30), (8, 20), (7, 10)):
        alert = make_alert()
        alert.id = alert_id
        alert.created_at = f"2026-07-20T10:{minute}:00Z"
        alerts.append(alert)
    service = AlertFakeCrowdSec(alerts)
    async with AsyncTestClient(app=make_app(service)) as client:
        first = await client.get("/api/v1/crowdsec/alerts", params={"limit": 2})
        assert first.status_code == 200
        cursor = first.json()["nextCursor"]
        assert isinstance(cursor, str)
        assert [alert["id"] for alert in first.json()["alerts"]] == [9, 8]
        second = await client.get(
            "/api/v1/crowdsec/alerts", params={"limit": 2, "before": cursor}
        )
    assert second.status_code == 200
    assert isinstance(service.alert_calls[-1]["created_before"], str)


async def test_alerts_reject_a_bad_cursor(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([make_alert()])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/alerts", params={"before": "nope"})
    assert resp.status_code == 400
    assert service.alert_calls == []


def test_alert_list_documents_its_409():
    schema = make_app(None).openapi_schema.to_schema()
    responses = schema["paths"]["/api/v1/crowdsec/alerts"]["get"]["responses"]
    assert "409" in responses


async def test_alerts_bot_group_rejects_a_scenario(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get(
            "/api/v1/crowdsec/alerts", params={"kind": "bot", "scenario": "x"}
        )
    assert resp.status_code == 400
    assert service.alert_calls == []


async def test_alerts_accept_the_bot_group(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/alerts", params={"kind": "bot"})
    assert resp.status_code == 200
    assert len(service.alert_calls) == 3


async def test_alerts_reject_an_unknown_kind(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/alerts", params={"kind": "robot"})
    assert resp.status_code == 400
    assert service.alert_calls == []


async def test_alerts_query_each_repeated_scenario(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get(
            "/api/v1/crowdsec/alerts",
            params=[("scenario", "crowdsecurity/ssh-bf"), ("scenario", "crowdsecurity/http-probing")],
        )
    assert resp.status_code == 200
    assert sorted(call["scenario"] for call in service.alert_calls) == [
        "crowdsecurity/http-probing", "crowdsecurity/ssh-bf",
    ]


async def test_alerts_reject_more_than_five_scenarios(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get(
            "/api/v1/crowdsec/alerts",
            params=[("scenario", f"crowdsecurity/scenario-{index}") for index in range(6)],
        )
    assert resp.status_code == 400
    assert "Pick at most 5 scenarios" in resp.text
    assert service.alert_calls == []


def alert_with_scenario(alert_id: int, scenario: str):
    alert = make_alert()
    alert.id = alert_id
    alert.scenario = scenario
    alert.created_at = f"2026-07-20T10:{59 - alert_id:02d}:00Z"
    return alert


async def test_alert_scenarios_count_newest_alerts_by_count_then_name(monkeypatch):
    enable_write(monkeypatch)
    alerts = [
        alert_with_scenario(alert_id, scenario)
        for alert_id, scenario in enumerate(
            [
                "crowdsecurity/ssh-bf", "crowdsecurity/http-probing", "crowdsecurity/http-crawl",
                "crowdsecurity/http-probing", "crowdsecurity/ssh-bf", "crowdsecurity/http-probing",
                "crowdsecurity/http-crawl",
            ],
            start=1,
        )
    ]
    service = AlertFakeCrowdSec(alerts)
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/alerts/scenarios", params={"since": "24h"})
    assert resp.status_code == 200
    assert resp.json() == [
        {"scenario": "crowdsecurity/http-probing", "count": 3},
        {"scenario": "crowdsecurity/http-crawl", "count": 2},
        {"scenario": "crowdsecurity/ssh-bf", "count": 2},
    ]
    assert service.alert_calls == [
        {
            "limit": 500, "created_before": None, "scenario": None, "since": "24h",
            "kind": None, "has_active_decision": None,
        }
    ]


async def test_alert_scenarios_forward_the_kind(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/alerts/scenarios", params={"kind": "waf"})
    assert resp.status_code == 200
    (call,) = service.alert_calls
    assert call["kind"] == "waf"


async def test_alert_scenarios_accept_the_bot_group(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/alerts/scenarios", params={"kind": "bot"})
    assert resp.status_code == 200
    assert len(service.alert_calls) == 3


@pytest.mark.parametrize("params", [{"kind": "robot"}, {"since": "1 day"}])
async def test_alert_scenarios_validate_kind_and_since(monkeypatch, params):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/alerts/scenarios", params=params)
    assert resp.status_code == 400
    assert service.alert_calls == []


async def test_alert_scenarios_403_without_machine_credentials(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    service = AlertFakeCrowdSec()
    async with AsyncTestClient(app=make_app(service)) as client:
        assert (await client.get("/api/v1/crowdsec/alerts/scenarios")).status_code == 403
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


async def test_alert_detail_names_the_lapi_country_code_from_geoip(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([make_london_alert(cn="GB")])
    async with AsyncTestClient(app=make_app(service, geoip=SpyGeoIp())) as client:
        detail = (await client.get("/api/v1/crowdsec/alerts/7")).json()
        via_decision = (
            await client.get("/api/v1/crowdsec/decisions/9/alert", params={"ip": LONDON_IP})
        ).json()
    assert (detail["countryCode"], detail["countryName"]) == ("GB", "United Kingdom")
    assert via_decision["countryName"] == "United Kingdom"


async def test_alert_detail_keeps_the_lapi_code_when_geoip_disagrees(monkeypatch):
    enable_write(monkeypatch)
    service = AlertFakeCrowdSec([make_london_alert(cn="NO")])
    async with AsyncTestClient(app=make_app(service, geoip=SpyGeoIp())) as client:
        detail = (await client.get("/api/v1/crowdsec/alerts/7")).json()
    assert (detail["countryCode"], detail["countryName"]) == ("NO", None)


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
        (listed,) = (await client.get("/api/v1/crowdsec/alerts")).json()["alerts"]
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
        (listed,) = (await client.get("/api/v1/crowdsec/alerts")).json()["alerts"]
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
            "countryCode": ["NO", "SE"], "city": ["Oslo"], "serverIn": ["a.test", "b.test"],
        })
    assert response.status_code == 200
    assert enrichment.location_calls == [["2001:db8::1", "1.2.3.4"]]
    assert enrichment.location_filters == {
        "country_codes": ["NO", "SE"], "cities": ["Oslo"], "servers": ["a.test", "b.test"],
    }
    assert response.json()["stats"] == {"ips": 0, "locations": 0, "events": 0, "countries": 0, "cities": 0}


# -- DROP networks: banned ranges, per-network traffic, bulk ban ------------

DROP_FETCHED_AT = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
DROP_SNAPSHOT = DropSnapshot(
    networks=(
        DropNetworkMatch("192.0.2.0/24", "SBL000002"),
        DropNetworkMatch("198.51.100.0/24", "SBL000001"),
        DropNetworkMatch("2001:db8::/32", "SBL000003"),
    ),
    feeds=(FeedState("v4", None, 2, None, DROP_FETCHED_AT, DROP_FETCHED_AT, None),),
)


class FakeDropTraffic(DropTrafficRepository):
    def __init__(self, hits: list[DropNetworkHits], origins: dict[str, DropNetworkOrigin] | None = None) -> None:
        self._hits = hits
        self._origins = origins or {}
        self.windows: list[timedelta] = []
        self.origin_requests: list[list[str]] = []

    async def network_hits(self, start, end):
        self.windows.append(end - start)
        return self._hits

    async def network_origins(self, cidrs, start, end):
        self.origin_requests.append(cidrs)
        return {cidr: self._origins[cidr] for cidr in cidrs if cidr in self._origins}


class UnreachableLapiCrowdSec(WritableFakeCrowdSec):
    async def get_decisions(self, **filters: Any) -> list[Decision]:
        raise CrowdSecUnavailableError("LAPI unreachable: boom")


class CrashingSecondBanCrowdSec(WritableFakeCrowdSec):
    """Raises something the bulk ban does not expect, on the second ban."""

    async def ban(self, value, **kwargs):
        if self.bans:
            raise RuntimeError("unexpected")
        await super().ban(value, **kwargs)


class FailingSecondBanCrowdSec(WritableFakeCrowdSec):
    """Raises on the second ban, the way a LAPI that drops mid-run would."""

    async def ban(self, value, **kwargs):
        if len(self.bans) == 1 and not getattr(self, "_failed", False):
            self._failed = True
            raise CrowdSecUnavailableError("LAPI unreachable: boom")
        await super().ban(value, **kwargs)


def range_decision(value: str, *, type: str = "ban", duration: str = "167h", **overrides: Any) -> Decision:
    return make_decision(scope="Range", value=value, type=type, duration=duration, **overrides)


async def test_banned_ranges_lists_only_range_decisions():
    service = FakeCrowdSec([
        make_decision(id=1, scope="Ip", value="192.0.2.5"),
        range_decision("192.0.2.0/24", id=2),
        make_decision(id=3, scope="Country", value="NO"),
    ])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/banned-ranges")
    assert resp.status_code == 200
    body = resp.json()
    assert [(banned_range["value"], banned_range["type"]) for banned_range in body] == [("192.0.2.0/24", "ban")]
    expires_at = datetime.fromisoformat(body[0]["expiresAt"])
    assert abs(expires_at - (datetime.now(UTC) + timedelta(hours=167))) < timedelta(minutes=1)


async def test_banned_ranges_keeps_the_strongest_type_and_canonical_cidr():
    service = FakeCrowdSec([
        range_decision("2001:DB8::/32", type="captcha", id=1),
        range_decision("2001:db8:0::/32", type="ban", id=2),
        range_decision("10.0.0.5/24", type="captcha", id=3),
    ])
    async with AsyncTestClient(app=make_app(service)) as client:
        resp = await client.get("/api/v1/crowdsec/banned-ranges")
    assert {banned_range["value"]: banned_range["type"] for banned_range in resp.json()} == {
        "2001:db8::/32": "ban",
        "10.0.0.0/24": "captcha",
    }


async def test_banned_ranges_404_when_crowdsec_is_disabled():
    async with AsyncTestClient(app=make_app(None)) as client:
        assert (await client.get("/api/v1/crowdsec/banned-ranges")).status_code == 404


DROP_HITS = [
    DropNetworkHits(cidr="198.51.100.0/24", sbl_id="SBL000001", hits=50, ips=3, last_seen=None),
    DropNetworkHits(cidr="192.0.2.0/24", sbl_id="SBL000002", hits=20, ips=1, last_seen=None),
    DropNetworkHits(cidr="2001:db8::/32", sbl_id="SBL000003", hits=5, ips=2, last_seen=None),
]


async def get_drop_networks(query: str = "", *, service=None, hits=DROP_HITS, snapshot=DROP_SNAPSHOT):
    origins = {
        "198.51.100.0/24": DropNetworkOrigin(asn=64496, as_org="EXAMPLE-AS", last_seen=DROP_FETCHED_AT),
    }
    traffic = FakeDropTraffic(hits, origins)
    app = make_app(service or FakeCrowdSec([]), drop_snapshot=snapshot, drop_traffic=traffic)
    async with AsyncTestClient(app=app) as client:
        resp = await client.get(f"/api/v1/crowdsec/drop-networks{query}")
    return resp, traffic


async def test_drop_networks_returns_traffic_totals_and_decisions():
    service = FakeCrowdSec([range_decision("192.0.2.0/24")])
    resp, traffic = await get_drop_networks("?days=7", service=service)
    assert resp.status_code == 200
    body = resp.json()
    assert traffic.windows == [timedelta(days=7)]
    assert {key: body[key] for key in ("loaded", "days", "totalNetworks", "totalIps", "totalHits", "bannedNetworks")} == {
        "loaded": True, "days": 7, "totalNetworks": 3, "totalIps": 6, "totalHits": 75, "bannedNetworks": 1,
    }
    assert [network_traffic["cidr"] for network_traffic in body["items"]] == ["198.51.100.0/24", "192.0.2.0/24", "2001:db8::/32"]
    first, second = body["items"][:2]
    assert (first["sblId"], first["asn"], first["asOrg"], first["hits"], first["ips"]) == (
        "SBL000001", 64496, "EXAMPLE-AS", 50, 3
    )
    assert first["lastSeen"] == "2026-11-01T12:00:00Z"
    assert first["decision"] is None
    assert second["decision"]["value"] == "192.0.2.0/24"
    assert (second["asn"], second["asOrg"], second["lastSeen"]) == (None, None, None)


async def test_drop_networks_looks_up_origins_for_the_page_only():
    resp, traffic = await get_drop_networks("?page=2&pageSize=2")
    assert [network_traffic["cidr"] for network_traffic in resp.json()["items"]] == ["2001:db8::/32"]
    assert resp.json()["totalNetworks"] == 3
    assert traffic.origin_requests == [["2001:db8::/32"]]


async def test_drop_networks_reports_the_window_in_the_schema():
    app = make_app(FakeCrowdSec([]))
    parameters = app.openapi_schema.to_schema()["paths"]["/api/v1/crowdsec/drop-networks"]["get"]["parameters"]
    days_parameter = next(parameter for parameter in parameters if parameter["name"] == "days")
    assert days_parameter["schema"]["enum"] == [7, 30, 90]


async def test_drop_networks_keeps_the_traffic_when_the_lapi_is_unreachable():
    with capture_logs() as logged_events:
        resp, _ = await get_drop_networks(service=UnreachableLapiCrowdSec())
    assert resp.status_code == 200
    warning_event = next(
        event for event in logged_events if event["event"] == "crowdsec_range_decisions_unavailable"
    )
    assert warning_event["log_level"] == "warning"
    assert "boom" in warning_event["error"]
    body = resp.json()
    assert body["decisionsAvailable"] is False
    assert body["bannedNetworks"] == 0
    assert [network_traffic["cidr"] for network_traffic in body["items"]] == ["198.51.100.0/24", "192.0.2.0/24", "2001:db8::/32"]
    assert all(network_traffic["decision"] is None for network_traffic in body["items"])


async def test_drop_networks_reports_decisions_as_available_normally():
    resp, _ = await get_drop_networks()
    assert resp.json()["decisionsAvailable"] is True


async def test_drop_networks_falls_back_to_the_stitched_last_seen_without_raw_rows():
    stitched_last_seen = datetime(2026, 10, 20, 8, 0, tzinfo=UTC)
    stitched_hits = [DropNetworkHits(
        cidr="192.0.2.0/24", sbl_id="SBL000002", hits=4, ips=1, last_seen=stitched_last_seen
    )]
    resp, _ = await get_drop_networks(hits=stitched_hits)
    network_traffic = resp.json()["items"][0]
    assert network_traffic["lastSeen"] == "2026-10-20T08:00:00Z"
    assert network_traffic["asn"] is None


async def test_drop_networks_rejects_other_windows():
    resp, _ = await get_drop_networks("?days=14")
    assert resp.status_code == 400


async def test_drop_networks_is_empty_when_no_list_is_loaded():
    resp, traffic = await get_drop_networks(snapshot=EMPTY_DROP_SNAPSHOT)
    assert resp.status_code == 200
    assert resp.json()["loaded"] is False
    assert resp.json()["items"] == []
    assert traffic.windows == []


async def test_drop_networks_404_when_crowdsec_is_disabled():
    async with AsyncTestClient(app=make_app(None)) as client:
        assert (await client.get("/api/v1/crowdsec/drop-networks")).status_code == 404


async def post_ban_networks(
    monkeypatch, body: dict, *, service=None, hits=DROP_HITS, snapshot=DROP_SNAPSHOT
) -> tuple[Any, WritableFakeCrowdSec, FakeDropTraffic]:
    enable_write(monkeypatch)
    service = service or WritableFakeCrowdSec()
    traffic = FakeDropTraffic(hits)
    app = make_app(service, drop_snapshot=snapshot, drop_traffic=traffic)
    async with AsyncTestClient(app=app) as client:
        resp = await client.post("/api/v1/crowdsec/ban-networks", json=body)
    return resp, service, traffic


async def test_ban_networks_bans_each_network_with_its_sbl_reason(monkeypatch):
    resp, service, _ = await post_ban_networks(
        monkeypatch, {"networks": ["192.0.2.0/24", "2001:db8::/32"], "duration": "7d"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"results": [
        {"network": "192.0.2.0/24", "ok": True, "error": None, "alreadyBanned": False},
        {"network": "2001:db8::/32", "ok": True, "error": None, "alreadyBanned": False},
    ], "leftOut": 0}
    assert service.bans == [
        {"value": "192.0.2.0/24", "scope": "Range", "type": "ban", "duration": "168h", "reason": "Spamhaus DROP SBL000002"},
        {"value": "2001:db8::/32", "scope": "Range", "type": "ban", "duration": "168h", "reason": "Spamhaus DROP SBL000003"},
    ]


async def test_ban_networks_reports_a_failure_in_the_middle_and_keeps_going(monkeypatch):
    resp, service, _ = await post_ban_networks(
        monkeypatch,
        {"networks": ["192.0.2.0/24", "198.51.100.0/24", "2001:db8::/32"], "duration": "24h"},
        service=FailingSecondBanCrowdSec(),
    )
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert [result["ok"] for result in results] == [True, False, True]
    assert "boom" in results[1]["error"]
    assert [ban["value"] for ban in service.bans] == ["192.0.2.0/24", "2001:db8::/32"]


async def test_ban_networks_rejects_a_network_that_is_not_on_the_list_and_bans_the_rest(monkeypatch):
    resp, service, _ = await post_ban_networks(
        monkeypatch, {"networks": ["203.0.113.0/24", "192.0.2.0/24", "nonsense"], "duration": "24h"}
    )
    results = resp.json()["results"]
    assert [(result["network"], result["ok"]) for result in results] == [
        ("203.0.113.0/24", False), ("192.0.2.0/24", True), ("nonsense", False),
    ]
    assert results[0]["error"] == "Not on the DROP list"
    assert [ban["value"] for ban in service.bans] == ["192.0.2.0/24"]


async def test_ban_networks_skips_a_listed_network_that_already_has_a_decision(monkeypatch):
    service = WritableFakeCrowdSec([range_decision("192.0.2.0/24")])
    resp, service, _ = await post_ban_networks(
        monkeypatch, {"networks": ["192.0.2.0/24", "2001:db8::/32"], "duration": "24h"}, service=service
    )
    assert resp.json()["results"] == [
        {"network": "192.0.2.0/24", "ok": True, "error": None, "alreadyBanned": True},
        {"network": "2001:db8::/32", "ok": True, "error": None, "alreadyBanned": False},
    ]
    assert [ban["value"] for ban in service.bans] == ["2001:db8::/32"]


async def test_ban_networks_still_bans_when_the_decision_lookup_fails(monkeypatch):
    service = UnreachableLapiCrowdSec()
    resp, service, _ = await post_ban_networks(
        monkeypatch, {"networks": ["192.0.2.0/24"], "duration": "24h"}, service=service
    )
    assert resp.status_code == 200
    assert [result["ok"] for result in resp.json()["results"]] == [True]
    assert [ban["value"] for ban in service.bans] == ["192.0.2.0/24"]


async def test_ban_networks_bans_a_network_whose_range_decision_has_expired(monkeypatch):
    service = WritableFakeCrowdSec([range_decision("192.0.2.0/24", duration="-1h")])
    async with AsyncTestClient(app=make_app(service)) as client:
        assert (await client.get("/api/v1/crowdsec/banned-ranges")).json() == []
    resp, service, _ = await post_ban_networks(
        monkeypatch, {"networks": ["192.0.2.0/24"], "duration": "24h"}, service=service
    )
    assert resp.json()["results"] == [
        {"network": "192.0.2.0/24", "ok": True, "error": None, "alreadyBanned": False},
    ]
    assert [ban["value"] for ban in service.bans] == ["192.0.2.0/24"]


HOST_PREFIX_SNAPSHOT = DropSnapshot(
    networks=(
        DropNetworkMatch("192.0.2.7/32", "SBL000007"),
        DropNetworkMatch("2001:db8::1/128", "SBL000008"),
    ),
    feeds=(FeedState("v4", None, 2, None, DROP_FETCHED_AT, DROP_FETCHED_AT, None),),
)


async def test_ban_networks_bans_a_single_address_network_as_an_ip_the_way_ban_does(monkeypatch):
    resp, service, _ = await post_ban_networks(
        monkeypatch,
        {"networks": ["192.0.2.7/32", "2001:db8::1/128"], "duration": "24h"},
        snapshot=HOST_PREFIX_SNAPSHOT,
    )
    _, single_service = await post_ban(monkeypatch, {"ip": "192.0.2.7/32"})

    assert [(result["network"], result["ok"]) for result in resp.json()["results"]] == [
        ("192.0.2.7/32", True), ("2001:db8::1/128", True),
    ]
    assert [(ban["scope"], ban["value"]) for ban in service.bans] == [("Ip", "192.0.2.7"), ("Ip", "2001:db8::1")]
    assert (single_service.bans[0]["scope"], single_service.bans[0]["value"]) == ("Ip", "192.0.2.7")


async def test_ban_networks_with_all_unbanned_days_skips_ranges_that_hold_a_decision(monkeypatch):
    service = WritableFakeCrowdSec([range_decision("198.51.100.0/24")])
    resp, service, traffic = await post_ban_networks(
        monkeypatch, {"allUnbannedDays": 90, "duration": "24h"}, service=service
    )
    assert resp.status_code == 200
    assert [result["network"] for result in resp.json()["results"]] == ["192.0.2.0/24", "2001:db8::/32"]
    assert [ban["reason"] for ban in service.bans] == ["Spamhaus DROP SBL000002", "Spamhaus DROP SBL000003"]
    assert traffic.windows == [timedelta(days=90)]


async def test_ban_networks_with_all_unbanned_days_bans_the_busiest_thousand_and_counts_the_rest(monkeypatch):
    many_networks = [f"10.{index // 256}.{index % 256}.0/24" for index in range(1003)]
    many_hits = [
        DropNetworkHits(cidr=cidr, sbl_id=f"SBL{index:06d}", hits=2000 - index, ips=1, last_seen=None)
        for index, cidr in enumerate(many_networks)
    ]
    many_snapshot = DropSnapshot(
        networks=tuple(DropNetworkMatch(network_hits.cidr, network_hits.sbl_id) for network_hits in many_hits),
        feeds=DROP_SNAPSHOT.feeds,
    )
    with capture_logs() as logged_events:
        resp, service, _ = await post_ban_networks(
            monkeypatch, {"allUnbannedDays": 7, "duration": "24h"},
            hits=many_hits, snapshot=many_snapshot,
        )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["results"]) == 1000
    assert body["leftOut"] == 3
    assert [ban["value"] for ban in service.bans] == many_networks[:1000]
    audit_event = next(event for event in logged_events if event["event"] == "crowdsec_bulk_ban")
    assert (audit_event["ok"], audit_event["left_out"]) == (1000, 3)


async def test_ban_networks_with_all_unbanned_days_reports_a_failure_and_keeps_going(monkeypatch):
    service = FailingSecondBanCrowdSec()
    resp, service, _ = await post_ban_networks(
        monkeypatch, {"allUnbannedDays": 30, "duration": "24h"}, service=service
    )
    assert [result["ok"] for result in resp.json()["results"]] == [True, False, True]


@pytest.mark.parametrize(
    "body",
    [
        {"duration": "24h"},
        {"networks": ["192.0.2.0/24"], "allUnbannedDays": 7, "duration": "24h"},
        {"networks": ["192.0.2.0/24"], "duration": "soon"},
        {"allUnbannedDays": 14, "duration": "24h"},
        {"networks": [f"10.{index // 256}.{index % 256}.0/24" for index in range(1001)], "duration": "24h"},
    ],
)
async def test_ban_networks_rejects_a_bad_request(monkeypatch, body):
    resp, service, _ = await post_ban_networks(monkeypatch, body)
    assert resp.status_code == 400
    assert service.bans == []


async def test_ban_networks_requires_write_enabled(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://crowdsec:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    monkeypatch.delenv("CROWDSEC_MACHINE_ID", raising=False)
    monkeypatch.delenv("CROWDSEC_MACHINE_PASSWORD", raising=False)
    service = WritableFakeCrowdSec()
    app = make_app(service, drop_snapshot=DROP_SNAPSHOT, drop_traffic=FakeDropTraffic([]))
    async with AsyncTestClient(app=app) as client:
        resp = await client.post(
            "/api/v1/crowdsec/ban-networks", json={"networks": ["192.0.2.0/24"], "duration": "24h"}
        )
    assert resp.status_code == 403
    assert service.bans == []


async def test_ban_networks_logs_who_banned_how_many(monkeypatch):
    with capture_logs() as logged_events:
        await post_ban_networks(
            monkeypatch,
            {"networks": ["192.0.2.0/24", "198.51.100.0/24", "2001:db8::/32"], "duration": "24h"},
            service=FailingSecondBanCrowdSec(),
        )
    audit_event = next(event for event in logged_events if event["event"] == "crowdsec_bulk_ban")
    assert (audit_event["actor"], audit_event["ok"], audit_event["failed"]) == ("unknown", 2, 1)
    assert (audit_event["mode"], audit_event["completed"], audit_event["already_banned"]) == ("networks", True, 0)


async def test_ban_networks_logs_the_audit_event_when_something_unexpected_escapes(monkeypatch):
    enable_write(monkeypatch)
    service = CrashingSecondBanCrowdSec()
    app = make_app(service, drop_snapshot=DROP_SNAPSHOT, drop_traffic=FakeDropTraffic(DROP_HITS))
    with capture_logs() as logged_events:
        async with AsyncTestClient(app=app, raise_server_exceptions=False) as client:
            resp = await client.post(
                "/api/v1/crowdsec/ban-networks", json={"allUnbannedDays": 7, "duration": "24h"}
            )
    assert resp.status_code == 500
    audit_event = next(event for event in logged_events if event["event"] == "crowdsec_bulk_ban")
    assert (audit_event["mode"], audit_event["completed"], audit_event["ok"]) == ("allUnbannedDays", False, 1)
