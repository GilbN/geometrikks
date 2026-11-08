"""The /api/v1/abuseipdb routes on the full app against Postgres, with AbuseIPDB mocked."""
from __future__ import annotations

from collections.abc import Callable

import httpx2
import pytest
from litestar.testing import AsyncTestClient

from geometrikks.config.settings import AbuseIpdbSettings, Settings
from geometrikks.server.core import create_app
from geometrikks.services.abuseipdb import AbuseIpdbClient
from tests.integration.test_drop_snapshot_pg import build_settings

pytestmark = pytest.mark.anyio

API_KEY = "test-key-2be6d4"
REPORT = {"ipAddress": "3.5.140.2", "categories": [21, 19], "comment": "probing", "attackTime": "2026-11-06T14:02:00Z"}
RATE_LIMIT_HEADERS = {"X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "986", "X-RateLimit-Reset": "1762560000"}

Handler = Callable[[httpx2.Request], httpx2.Response]


def accept(request: httpx2.Request) -> httpx2.Response:
    return httpx2.Response(
        200, json={"data": {"ipAddress": "3.5.140.2", "abuseConfidenceScore": 52}}, headers=RATE_LIMIT_HEADERS
    )


def time_out(request: httpx2.Request) -> httpx2.Response:
    raise httpx2.ReadTimeout("simulated", request=request)


@pytest.fixture()
def app_settings(migrated_database_url: str) -> Settings:
    settings = build_settings(migrated_database_url)
    return settings.model_copy(
        update={"abuseipdb": AbuseIpdbSettings(api_key=API_KEY, reporting_enabled=True, _env_file=None)}
    )


@pytest.fixture()
def use_upstream(monkeypatch: pytest.MonkeyPatch, app_settings: Settings) -> Callable[[Handler], list[httpx2.Request]]:
    def install(handler: Handler) -> list[httpx2.Request]:
        calls: list[httpx2.Request] = []

        def recording(request: httpx2.Request) -> httpx2.Response:
            calls.append(request)
            return handler(request)

        client = AbuseIpdbClient(
            api_key=API_KEY,
            timeout=app_settings.abuseipdb.request_timeout,
            transport=httpx2.MockTransport(recording),
        )
        monkeypatch.setattr("geometrikks.services.abuseipdb._client", client)
        return calls

    return install


async def test_post_reports_and_shows_in_lists(app_settings, use_upstream, clean_abuseipdb_reports):
    calls = use_upstream(accept)
    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        resp = await client.post("/api/v1/abuseipdb/reports", json={"reports": [REPORT]})
        reported_ips = await client.get("/api/v1/abuseipdb/reported-ips")
        stored_resp = await client.get("/api/v1/abuseipdb/reports", params={"ipAddress": "3.5.140.2"})

    assert resp.status_code == 200
    result = resp.json()["results"][0]
    assert result["reportedAt"] is not None
    assert result | {"reportedAt": None} == {
        "ipAddress": "3.5.140.2", "status": "reported", "abuseConfidenceScore": 52, "reportedAt": None, "error": None,
    }
    assert len(calls) == 1
    assert [row["ipAddress"] for row in reported_ips.json()] == ["3.5.140.2"]
    assert reported_ips.json()[0]["status"] == "sent"
    stored = stored_resp.json()
    assert len(stored) == 1
    assert stored[0]["reporterKind"] == "anonymous" and stored[0]["status"] == "sent"
    assert stored[0] | {"id": None, "reportedAt": None} == {
        "id": None,
        "ipAddress": "3.5.140.2",
        "categories": [21, 19],
        "comment": "probing",
        "attackTime": "2026-11-06T14:02:00Z",
        "status": "sent",
        "reportedAt": None,
        "abuseConfidenceScore": 52,
        "reporterKind": "anonymous",
        "reporterName": None,
    }


async def test_repeat_within_15_minutes_is_429_with_retry_after(app_settings, use_upstream, clean_abuseipdb_reports):
    calls = use_upstream(accept)
    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        first = await client.post("/api/v1/abuseipdb/reports", json={"reports": [REPORT]})
        repeat = await client.post("/api/v1/abuseipdb/reports", json={"reports": [REPORT]})

    assert first.status_code == 200
    assert repeat.status_code == 429
    assert repeat.json()["code"] == "abuseipdb_recent_report"
    assert 0 < int(repeat.headers["retry-after"]) <= 15 * 60
    assert len(calls) == 1


async def test_uncertain_outcome_is_502_and_listed_as_unconfirmed(app_settings, use_upstream, clean_abuseipdb_reports):
    use_upstream(time_out)
    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        resp = await client.post("/api/v1/abuseipdb/reports", json={"reports": [REPORT]})
        reported_ips = await client.get("/api/v1/abuseipdb/reported-ips")
        stored = await client.get("/api/v1/abuseipdb/reports", params={"ipAddress": "3.5.140.2"})

    assert resp.status_code == 502
    assert resp.json()["code"] == "abuseipdb_unconfirmed"
    assert [(row["ipAddress"], row["status"]) for row in reported_ips.json()] == [("3.5.140.2", "unconfirmed")]
    assert [(row["status"], row["abuseConfidenceScore"]) for row in stored.json()] == [("unconfirmed", None)]


async def test_status_reports_remaining_after_a_report(app_settings, use_upstream, clean_abuseipdb_reports):
    use_upstream(accept)
    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        before = (await client.get("/api/v1/abuseipdb/status")).json()
        await client.post("/api/v1/abuseipdb/reports", json={"reports": [REPORT]})
        body = (await client.get("/api/v1/abuseipdb/status")).json()

    assert before == {
        "enabled": True,
        "reportingEnabled": True,
        "blacklistEnabled": False,
        "reports": None,
        "checks": None,
    }
    assert body["enabled"] is True and body["reportingEnabled"] is True
    assert body["reports"] == {"limit": 1000, "remaining": 986, "resetsAt": "2025-11-08T00:00:00Z"}
    assert body["checks"] is None


async def test_reports_for_another_spelling_of_the_ip(app_settings, use_upstream, clean_abuseipdb_reports):
    use_upstream(accept)
    async with AsyncTestClient(app=create_app(settings=app_settings)) as client:
        await client.post("/api/v1/abuseipdb/reports", json={"reports": [REPORT]})
        mapped = await client.get("/api/v1/abuseipdb/reports", params={"ipAddress": "::ffff:3.5.140.2"})
        private = await client.get("/api/v1/abuseipdb/reports", params={"ipAddress": "10.0.0.5"})

    assert [row["ipAddress"] for row in mapped.json()] == ["3.5.140.2"]
    assert private.status_code == 400
    assert private.json()["code"] == "invalid_ip"
