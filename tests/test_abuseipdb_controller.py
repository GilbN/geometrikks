"""The /api/v1/abuseipdb routes without a database: settings gates, the check and request validation."""
from __future__ import annotations

import traceback
from typing import Any

import httpx2
import pytest
from litestar import Litestar
from litestar.di import Provide
from litestar.logging.config import StructLoggingConfig
from litestar.testing import AsyncTestClient
from structlog.testing import capture_logs

from geometrikks.domain.abuseipdb.controllers import AbuseIpdbController
from geometrikks.server.exceptions import EXCEPTION_HANDLERS
from geometrikks.server.logging import _capture_exc_info, _exception_logging_handler_factory
from geometrikks.server.routes import create_api_v1_router
from geometrikks.services.abuseipdb import AbuseIpdbClient
from tests.support import ambient_settings_dependency

pytestmark = pytest.mark.anyio

API_KEY = "test-key-81d3e0"
CHECK_ANSWER = {
    "data": {
        "ipAddress": "3.5.140.2",
        "abuseConfidenceScore": 37,
        "totalReports": 12,
        "numDistinctUsers": 4,
        "lastReportedAt": "2026-11-06T14:02:00+00:00",
        "usageType": "Data Center/Web Hosting/Transit",
        "isp": "Amazon.com, Inc.",
        "domain": "amazon.com",
        "isTor": False,
        "isWhitelisted": None,
        "countryCode": "US",
    }
}
VALID_REPORT = {
    "ipAddress": "3.5.140.2",
    "categories": [21, 19],
    "comment": "probing",
    "attackTime": "2026-11-06T14:02:00Z",
}


def recording_client(calls: list[httpx2.Request]) -> AbuseIpdbClient:
    def handler(request: httpx2.Request) -> httpx2.Response:
        calls.append(request)
        return httpx2.Response(
            200, json=CHECK_ANSWER, headers={"X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "999"}
        )

    return AbuseIpdbClient(api_key=API_KEY, timeout=5, transport=httpx2.MockTransport(handler))


class _UnsentReports:
    """Just enough of the repository for a report whose AbuseIPDB call fails as maybe sent."""

    async def latest_reported_at(self, ip: str) -> None:
        return None

    async def add(self, row: Any, **_: Any) -> Any:
        row.id = 1
        return row


def make_app(
    client: AbuseIpdbClient | None,
    reports: object = None,
    logging_config: StructLoggingConfig | None = None,
) -> Litestar:
    class _TestController(AbuseIpdbController):
        dependencies = {
            **(AbuseIpdbController.dependencies or {}),
            "abuseipdb": Provide(lambda: client, sync_to_thread=False),
            # Every route here except the maybe-sent report fails before it reaches the database.
            "abuseipdb_reports": Provide(lambda: reports, sync_to_thread=False),
            "abuseipdb_blacklist": Provide(lambda: None, sync_to_thread=False),
        }

    return Litestar(
        route_handlers=[create_api_v1_router([_TestController])],
        dependencies=ambient_settings_dependency(),
        exception_handlers=EXCEPTION_HANDLERS,
        logging_config=logging_config,
    )


async def test_status_without_a_key():
    async with AsyncTestClient(make_app(None)) as http:
        resp = await http.get("/api/v1/abuseipdb/status")
    assert resp.status_code == 200
    assert resp.json() == {
        "enabled": False,
        "reportingEnabled": False,
        "blacklistEnabled": False,
        "reports": None,
        "checks": None,
    }


async def test_check_404_without_a_key():
    async with AsyncTestClient(make_app(None)) as http:
        resp = await http.get("/api/v1/abuseipdb/check", params={"ipAddress": "3.5.140.2"})
    assert resp.status_code == 404
    assert resp.json()["code"] == "abuseipdb_disabled"


@pytest.mark.parametrize("ip_address", ["10.0.0.5", "127.0.0.2", "203.0.113.7", "not-an-ip"])
async def test_check_refuses_private_ips_without_a_call(ip_address: str):
    calls: list[httpx2.Request] = []
    async with AsyncTestClient(make_app(recording_client(calls))) as http:
        resp = await http.get("/api/v1/abuseipdb/check", params={"ipAddress": ip_address})
    assert resp.status_code == 400
    assert resp.json()["code"] == "invalid_ip"
    assert calls == []


async def test_check_returns_the_score_and_spends_one_check():
    calls: list[httpx2.Request] = []
    with capture_logs() as captured_logs:
        async with AsyncTestClient(make_app(recording_client(calls))) as http:
            first = await http.get("/api/v1/abuseipdb/check", params={"ipAddress": "3.5.140.2"})
            second = await http.get("/api/v1/abuseipdb/check", params={"ipAddress": "3.5.140.2"})
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json() == {
        "ipAddress": "3.5.140.2",
        "abuseConfidenceScore": 37,
        "totalReports": 12,
        "numDistinctUsers": 4,
        "lastReportedAt": "2026-11-06T14:02:00Z",
        "usageType": "Data Center/Web Hosting/Transit",
        "isp": "Amazon.com, Inc.",
        "domain": "amazon.com",
        "isTor": False,
        "isWhitelisted": None,
        "countryCode": "US",
    }
    assert len(calls) == 1
    check_logs = [entry for entry in captured_logs if entry["event"] == "abuseipdb_check"]
    assert [(entry["ip_address"], entry["score"]) for entry in check_logs] == [("3.5.140.2", 37)] * 2
    assert not any(API_KEY in str(entry) for entry in captured_logs)


@pytest.mark.parametrize(
    ("status", "headers", "expected_status", "expected_code"),
    [
        (429, {"Retry-After": "60"}, 429, "abuseipdb_rate_limited"),
        (401, {}, 502, "abuseipdb_failed"),
        (503, {}, 502, "abuseipdb_failed"),
    ],
)
async def test_check_maps_upstream_errors(status: int, headers: dict[str, str], expected_status: int, expected_code: str):
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(status, json={"errors": [{"detail": "nope", "status": status}]}, headers=headers)

    client = AbuseIpdbClient(api_key=API_KEY, timeout=5, transport=httpx2.MockTransport(handler))
    async with AsyncTestClient(make_app(client)) as http:
        resp = await http.get("/api/v1/abuseipdb/check", params={"ipAddress": "3.5.140.2"})
    assert resp.status_code == expected_status
    assert resp.json()["code"] == expected_code
    if status == 429:
        assert resp.headers["retry-after"] == "60"


async def test_post_refused_when_reporting_is_off():
    calls: list[httpx2.Request] = []
    async with AsyncTestClient(make_app(recording_client(calls))) as http:
        resp = await http.post("/api/v1/abuseipdb/reports", json={"reports": [VALID_REPORT]})
    assert resp.status_code == 403
    assert resp.json()["code"] == "abuseipdb_reporting_disabled"
    assert calls == []


@pytest.mark.parametrize("reports", [[], [VALID_REPORT, VALID_REPORT | {"ipAddress": "8.8.8.8"}]])
async def test_post_takes_exactly_one_item(reports: list[dict[str, object]]):
    async with AsyncTestClient(make_app(None)) as http:
        resp = await http.post("/api/v1/abuseipdb/reports", json={"reports": reports})
    assert resp.status_code == 400
    assert resp.json()["code"] == "validation_failed"


@pytest.mark.parametrize(
    "body",
    [
        {"reports": [VALID_REPORT], "extra": True},
        {"reports": [VALID_REPORT | {"apiKeyId": "x"}]},
        {"reports": [VALID_REPORT | {"categories": [24]}]},
        {"reports": [VALID_REPORT | {"categories": [0]}]},
        {"reports": [VALID_REPORT | {"categories": []}]},
        {"reports": [VALID_REPORT | {"comment": ""}]},
        {"reports": [VALID_REPORT | {"comment": "x" * 1025}]},
    ],
)
async def test_post_rejects_unknown_fields_and_bad_categories(body: dict[str, object]):
    async with AsyncTestClient(make_app(None)) as http:
        resp = await http.post("/api/v1/abuseipdb/reports", json=body)
    assert resp.status_code == 400
    assert resp.json()["code"] == "validation_failed"


async def test_key_rejected_by_the_http_layer_never_reaches_the_logs(monkeypatch):
    padded_key = f"{API_KEY}\n"
    monkeypatch.setenv("ABUSEIPDB_API_KEY", API_KEY)
    monkeypatch.setenv("ABUSEIPDB_REPORTING_ENABLED", "true")

    def handler(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.LocalProtocolError(f"Illegal header value {padded_key.encode()!r}")

    client = AbuseIpdbClient(api_key=padded_key, timeout=5, transport=httpx2.MockTransport(handler))
    app = make_app(
        client,
        reports=_UnsentReports(),
        logging_config=StructLoggingConfig(
            log_exceptions="always",
            exception_logging_handler=_exception_logging_handler_factory(debug=False),
            cache_logger_on_first_use=False,
        ),
    )
    # The real pipeline resolves exc_info=True to the live exception before anything renders it.
    processors: list[Any] = [_capture_exc_info]
    with capture_logs(processors=processors) as captured_logs:
        async with AsyncTestClient(app) as http:
            resp = await http.post("/api/v1/abuseipdb/reports", json={"reports": [VALID_REPORT]})

    assert resp.status_code == 502
    assert resp.json()["code"] == "abuseipdb_unconfirmed"
    assert API_KEY not in resp.text
    assert "Uncaught exception" in [entry["event"] for entry in captured_logs]
    rendered = [
        "".join(traceback.format_exception(entry["exc_info"][1]))
        for entry in captured_logs
        if isinstance(entry.get("exc_info"), tuple)
    ]
    assert rendered
    assert not any(API_KEY in str(entry) for entry in captured_logs)
    assert not any(API_KEY in text for text in rendered)
