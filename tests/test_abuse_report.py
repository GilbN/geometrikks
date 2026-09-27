"""Abuse reports: redaction, the endpoint contract and CrowdSec degradation."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient

from geometrikks.domain.reports.abuse_report import (
    AbuseReportRepository,
    AsnSelection,
    Redactor,
    ReportEvidence,
    ReportIp,
    ReportLine,
    redaction_terms,
    registrable_domain,
    secret_param,
)
from geometrikks.domain.reports.controllers import ReportsController
from geometrikks.domain.reports.crowdsec import alert_in_window, gather_crowdsec
from geometrikks.server.exceptions import EXCEPTION_HANDLERS
from geometrikks.server.routes import create_api_v1_router
from geometrikks.services.crowdsec import Alert, CrowdSecService, CrowdSecUnavailableError, Decision
from geometrikks.services.crowdsec.schemas import AlertSource
from tests.support import ambient_settings_dependency

pytestmark = pytest.mark.anyio

NOW = datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc)
START = NOW - timedelta(days=7)
WINDOW = {"startDate": START.isoformat(), "endDate": NOW.isoformat()}


# -- redaction ---------------------------------------------------------------


def test_operator_hosts_bring_their_registrable_domain():
    terms = redaction_terms(["home.example.com", "example.org:8443"], [], [])
    assert terms == ["home.example.com", "example.com", "example.org"]


def test_country_second_level_domains_keep_three_labels():
    assert registrable_domain("blog.example.co.uk") == "example.co.uk"
    assert registrable_domain("blog.example.com.au") == "example.com.au"
    assert registrable_domain("example.co") == "example.co"
    assert redaction_terms(["blog.example.co.uk"], [], []) == ["blog.example.co.uk", "example.co.uk"]


def test_row_hosts_count_only_under_an_operator_domain():
    # A proxy probe's spoofed Host is evidence, not the operator's name.
    terms = redaction_terms(["example.com"], ["cpanel.example.com", "www.google.com"], [])
    assert terms == ["cpanel.example.com", "example.com"]


def test_public_addresses_count_and_private_ones_do_not():
    terms = redaction_terms(["195.0.194.210", "195.000.194.210", "127.0.0.1", "0.0.0.0", "[2001:db8::1]:443"], [], [])
    assert terms == ["195.000.194.210", "195.0.194.210"]


def test_dotless_names_are_left_alone():
    assert redaction_terms(["localhost", "_", "test"], ["test"], ["ubuntu", "nostromo"]) == []


def test_dotted_instance_names_count():
    assert redaction_terms([], [], ["proxy.lan.example.net"]) == ["proxy.lan.example.net"]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("GET http://home.example.com/x", "GET http://[redacted]/x"),
        ("/?u=http%3A%2F%2FWWW.EXAMPLE.COM%2F", "/?u=http%3A%2F%2FWWW.[redacted]%2F"),
        ("/example.community", "/example.community"),
        ("/test.php", "/test.php"),
    ],
)
def test_redactor_scrubs_whole_names_only(value, expected):
    redact = Redactor(redaction_terms(["home.example.com"], [], []))
    assert redact(value) == expected


def test_redactor_counts_replacements():
    redact = Redactor(["example.com"])
    redact("http://example.com/?next=example.com")
    redact("/nothing")
    assert redact.replacements == 2


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "/?rd=https%3A%2F%2Fauth.example.com%2Fapp%2Fapi%3Fapikey%3Dabc&rm=GET",
            "/?rd=[redacted]&rm=GET",
        ),
        ("/login?apikey=test&user=admin", "/login?apikey=[redacted]&user=admin"),
        ("/stable-1?reconnectionToken=22d1&reconnection=true", "/stable-1?reconnectionToken=[redacted]&reconnection=true"),
        ("/library?X-Plex-Token=abc", "/library?X-Plex-Token=[redacted]"),
        (
            "/index.php?s=/Index/\\think\\app/invokefunction&function=call_user_func_array",
            "/index.php?s=/Index/\\think\\app/invokefunction&function=call_user_func_array",
        ),
        ("http://auth.example.com/x?q=1", "http://[redacted]/x?q=1"),
        ("/x?token=", "/x?token="),
    ],
)
def test_url_redaction_drops_operator_urls_and_credentials(url, expected):
    redact = Redactor(redaction_terms(["auth.example.com"], [], []))
    assert redact.url(url) == expected


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("/x?h=195.000.194.210", "/x?h=[redacted]"),
        ("/?rd=%2Fapi%3Fapikey%3Dabc&x=1", "/?rd=[redacted]&x=1"),
        ("/?rd=/api?apikey=abc", "/?rd=[redacted]"),
        ("/?code=phpinfo();&zipcode=1&monkey=2", "/?code=phpinfo();&zipcode=1&monkey=2"),
        ("/proxy/auth%2Eexample%2Ecom/", "/proxy/[redacted]/"),
        ("/go http://user:pass@auth.example.com/", "/go http://[redacted]/"),
    ],
)
def test_url_redaction_edge_cases(url, expected):
    redact = Redactor(redaction_terms(["auth.example.com", "195.0.194.210"], [], []))
    assert redact.url(url) == expected


def test_ipv6_terms_match_the_written_out_form():
    redact = Redactor(redaction_terms(["[2a01:4f8:c0c:1234::1]:443"], [], []))
    assert redact("[2A01:04F8:0C0C:1234:0000:0000:0000:0001]") == "[[redacted]]"
    assert redact("2a01:4f8:c0c:1234::10") == "2a01:4f8:c0c:1234::10"


@pytest.mark.parametrize(
    ("name", "secret"),
    [
        ("apikey", True), ("api_key", True), ("apiKey", True), ("X-Plex-Token", True),
        ("reconnectionToken", True), ("PHPSESSID", True),
        ("code", False), ("zipcode", False), ("monkey", False), ("oauth", False),
    ],
)
def test_secret_param_names(name, secret):
    assert secret_param(name) is secret


def test_url_redaction_drops_credentials_without_any_terms():
    assert Redactor([]).url("/x?api_key=SECRET&q=1") == "/x?api_key=[redacted]&q=1"


def test_redactor_without_terms_is_identity():
    assert Redactor([])("/anything") == "/anything"


# -- CrowdSec evidence -------------------------------------------------------


def make_alert(**overrides: Any) -> Alert:
    values: dict[str, Any] = {
        "id": 1,
        "scenario": "crowdsecurity/http-probing",
        "message": "",
        "events_count": 11,
        "created_at": "2026-09-25T10:00:00Z",
        "start_at": "2026-09-25T09:59:00Z",
        "stop_at": "2026-09-25T10:00:00Z",
        "source": AlertSource(scope="Ip", value="198.51.100.7"),
        "machine_id": "nostromo-machine",
        "decisions": [],
        **overrides,
    }
    return Alert(**values)


def make_decision(**overrides: Any) -> Decision:
    values: dict[str, Any] = {
        "id": 1,
        "origin": "crowdsec",
        "type": "ban",
        "scope": "Ip",
        "value": "198.51.100.7",
        "duration": "3h59m",
        "scenario": "crowdsecurity/http-probing",
        **overrides,
    }
    return Decision(**values)


class FakeCrowdSec(CrowdSecService):
    def __init__(
        self,
        *,
        decisions: list[Decision] | None = None,
        alerts: list[Alert] | None = None,
        fail: bool = False,
    ) -> None:
        self._decisions = decisions or []
        self._alerts = alerts or []
        self._fail = fail
        self.alert_calls: list[dict[str, Any]] = []

    async def get_decisions_for_ip(self, ip: str) -> list[Decision]:
        if self._fail:
            raise CrowdSecUnavailableError("down")
        return [d for d in self._decisions if d.value == ip]

    async def get_alerts(self, **filters: Any) -> list[Alert]:
        self.alert_calls.append(filters)
        return [a for a in self._alerts if a.source.value == filters.get("ip")]


def test_alert_overlapping_the_window_is_kept():
    alert = make_alert(start_at="2026-09-19T11:00:00Z", stop_at="2026-09-19T12:30:00Z")
    assert alert_in_window(alert, START, NOW)


def test_alert_before_the_window_is_dropped():
    alert = make_alert(start_at="2026-09-18T11:00:00Z", stop_at="2026-09-18T11:30:00Z")
    assert not alert_in_window(alert, START, NOW)


def test_alert_with_unparseable_times_is_kept():
    assert alert_in_window(make_alert(start_at=None, stop_at=None, created_at="garbage"), START, NOW)


async def test_no_service_reports_disabled():
    evidence = await gather_crowdsec(None, ["198.51.100.7"], START, NOW, alerts_enabled=True)
    assert evidence.status == "disabled"


async def test_lapi_failure_degrades_instead_of_raising():
    evidence = await gather_crowdsec(
        FakeCrowdSec(fail=True), ["198.51.100.7", "198.51.100.8"], START, NOW, alerts_enabled=True
    )
    assert (evidence.status, evidence.by_ip) == ("unavailable", {})


async def test_without_machine_credentials_only_decisions_are_fetched():
    service = FakeCrowdSec(decisions=[make_decision()], alerts=[make_alert()])
    evidence = await gather_crowdsec(service, ["198.51.100.7"], START, NOW, alerts_enabled=False)
    assert evidence.status == "decisions-only"
    assert service.alert_calls == []
    assert len(evidence.by_ip["198.51.100.7"].decisions) == 1


async def test_alert_lookback_starts_at_the_window():
    service = FakeCrowdSec()
    await gather_crowdsec(service, ["198.51.100.7"], START, NOW, alerts_enabled=True, now=NOW)
    assert service.alert_calls == [{"limit": 1000, "ip": "198.51.100.7", "since": "168h", "until": None}]


async def test_an_older_window_bounds_alerts_at_its_end():
    service = FakeCrowdSec()
    await gather_crowdsec(
        service, ["198.51.100.7"], START, NOW, alerts_enabled=True, now=NOW + timedelta(hours=50, minutes=30)
    )
    # 50.5 hours since the window end rounds down, so its last partial hour stays in.
    assert service.alert_calls[0]["until"] == "50h"


async def test_alert_limit_hit_marks_the_list_truncated():
    service = FakeCrowdSec(alerts=[make_alert(id=i) for i in range(3)])
    evidence = await gather_crowdsec(
        service, ["198.51.100.7"], START, NOW, alerts_enabled=True, alert_limit=3, now=NOW
    )
    assert evidence.by_ip["198.51.100.7"].alerts_truncated


# -- endpoint ----------------------------------------------------------------


class FakeRepo(AbuseReportRepository):
    def __init__(self, evidence: dict[str, ReportIp], selection: AsnSelection | None = None) -> None:
        self._evidence = evidence
        self._selection = selection
        self.evidence_calls: list[list[str]] = []

    async def select_asn_ips(self, asn, start, end, limit) -> AsnSelection:
        assert self._selection is not None
        return self._selection

    async def get_evidence(self, ips, start, end, *, lines_per_ip) -> ReportEvidence:
        self.evidence_calls.append(ips)
        return ReportEvidence(
            granularity="hourly",
            ips=[self._evidence.get(ip, ReportIp(ip=ip)) for ip in ips],
            redactions=2,
        )


def make_app(repo: FakeRepo, crowdsec: FakeCrowdSec | None = None) -> Litestar:
    class _TestController(ReportsController):
        dependencies = {
            **ReportsController.dependencies,
            "abuse_report_repo": Provide(lambda: repo, sync_to_thread=False),
        }

    app = Litestar(
        route_handlers=[create_api_v1_router([_TestController])],
        dependencies=ambient_settings_dependency(),
        exception_handlers=EXCEPTION_HANDLERS,
    )
    app.state.crowdsec_service = crowdsec
    return app


def enable_crowdsec_writes(monkeypatch) -> None:
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://lapi.test:8080")
    monkeypatch.setenv("CROWDSEC_BOUNCER_API_KEY", "key")
    monkeypatch.setenv("CROWDSEC_MACHINE_ID", "machine")
    monkeypatch.setenv("CROWDSEC_MACHINE_PASSWORD", "secret")


@pytest.mark.parametrize("query", [{}, {"ipAddress": "198.51.100.7", "asn": "64500"}])
async def test_report_needs_exactly_one_target(query):
    async with AsyncTestClient(make_app(FakeRepo({}))) as client:
        resp = await client.get("/api/v1/reports/abuse", params={**WINDOW, **query})
    assert resp.status_code == 400
    assert "exactly one" in resp.json()["detail"]


async def test_report_rejects_an_invalid_ip():
    async with AsyncTestClient(make_app(FakeRepo({}))) as client:
        resp = await client.get("/api/v1/reports/abuse", params={**WINDOW, "ipAddress": "not-an-ip"})
    assert resp.status_code == 400


async def test_ip_report_canonicalizes_the_address():
    repo = FakeRepo({})
    async with AsyncTestClient(make_app(repo)) as client:
        resp = await client.get("/api/v1/reports/abuse", params={**WINDOW, "ipAddress": "2001:DB8:0::1"})
    assert resp.status_code == 200
    assert repo.evidence_calls == [["2001:db8::1"]]
    assert resp.json()["target"]["ipAddress"] == "2001:db8::1"


async def test_ip_report_wire_shape():
    item = ReportIp(
        ip="198.51.100.7", total_requests=3, status_4xx=3, asn=64500, asn_organization="Example Hosting",
        first_seen=NOW - timedelta(hours=2), last_seen=NOW - timedelta(hours=1),
        lines=[ReportLine(
            timestamp=NOW - timedelta(hours=1), method="GET", url="/.env", http_version="HTTP/1.1",
            status_code=404, bytes_sent=153, user_agent="curl/8.0",
        )],
    )
    async with AsyncTestClient(make_app(FakeRepo({"198.51.100.7": item}))) as client:
        resp = await client.get("/api/v1/reports/abuse", params={**WINDOW, "ipAddress": "198.51.100.7"})
    body = resp.json()
    assert body["target"] == {
        "kind": "ip", "ipAddress": "198.51.100.7", "asn": 64500, "asnOrganization": "Example Hosting",
    }
    assert (body["ipCount"], body["totalRequests"], body["redactions"]) == (1, 3, 2)
    assert body["crowdsec"] == {"status": "disabled", "message": None}
    ip = body["ips"][0]
    assert (ip["status4xx"], ip["alertsTruncated"]) == (3, False)
    assert ip["lines"][0]["url"] == "/.env"
    assert "host" not in ip["lines"][0] and "referrer" not in ip["lines"][0]


async def test_asn_report_carries_selection_totals():
    selection = AsnSelection(
        ips=["198.51.100.7", "198.51.100.8"], ip_count=40, total_requests=900, total_4xx=700,
        organization="Example Hosting",
    )
    repo = FakeRepo({}, selection)
    async with AsyncTestClient(make_app(repo)) as client:
        resp = await client.get("/api/v1/reports/abuse", params={**WINDOW, "asn": "64500", "maxIps": "2"})
    body = resp.json()
    assert body["target"] == {"kind": "asn", "ipAddress": None, "asn": 64500, "asnOrganization": "Example Hosting"}
    assert (body["ipCount"], body["totalRequests"], body["status4xx"], len(body["ips"])) == (40, 900, 700, 2)


async def test_manual_bans_lose_their_reason_and_machine(monkeypatch):
    enable_crowdsec_writes(monkeypatch)
    service = FakeCrowdSec(
        decisions=[
            make_decision(origin="geometrikks", scenario="geometrikks/manual-ban: my neighbour's IP"),
            make_decision(origin="cscli", scenario="manual 'ban' from 'nostromo-machine'"),
            make_decision(origin="cscli-import", scenario="imported by nostromo"),
            make_decision(),
            make_decision(origin="CAPI", scenario="crowdsecurity/ssh-bf"),
        ],
        alerts=[
            make_alert(scenario="geometrikks/manual-ban"),
            make_alert(scenario="manual 'ban' from 'nostromo-machine'", kind="cscli"),
            make_alert(scenario="crowdsecurity/http-probing", kind="cscli"),
            make_alert(),
            make_alert(scenario="crowdsecurity/http-bad-user-agent", kind="waf"),
        ],
    )
    async with AsyncTestClient(make_app(FakeRepo({}), service)) as client:
        resp = await client.get("/api/v1/reports/abuse", params={**WINDOW, "ipAddress": "198.51.100.7"})
    ip = resp.json()["ips"][0]
    assert [d["scenario"] for d in ip["decisions"]] == [
        "manual", "manual", "manual", "crowdsecurity/http-probing", "crowdsecurity/ssh-bf",
    ]
    assert [a["scenario"] for a in ip["alerts"]] == [
        "manual", "manual", "manual", "crowdsecurity/http-probing", "crowdsecurity/http-bad-user-agent",
    ]
    assert "nostromo" not in resp.text


async def test_lapi_outage_still_returns_the_logs(monkeypatch):
    enable_crowdsec_writes(monkeypatch)
    async with AsyncTestClient(make_app(FakeRepo({}), FakeCrowdSec(fail=True))) as client:
        resp = await client.get("/api/v1/reports/abuse", params={**WINDOW, "ipAddress": "198.51.100.7"})
    assert resp.status_code == 200
    assert resp.json()["crowdsec"]["status"] == "unavailable"
