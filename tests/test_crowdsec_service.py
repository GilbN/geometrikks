"""CrowdSecService read path: parsing, headers, error translation."""
from __future__ import annotations

import json

import httpx
import pytest

from geometrikks.config.settings import CrowdSecSettings
from geometrikks.services.crowdsec import (
    CrowdSecAuthError,
    CrowdSecService,
    CrowdSecUnavailableError,
    Decision,
)

DECISION_JSON = {
    "id": 42,
    "origin": "cscli",
    "type": "ban",
    "scope": "Ip",
    "value": "1.2.3.4",
    "duration": "3h59m",
    "scenario": "manual ban",
}


def make_settings(**overrides) -> CrowdSecSettings:
    values = {
        "lapi_url": "http://crowdsec:8080",
        "bouncer_api_key": "bouncer-key",
        **overrides,
    }
    return CrowdSecSettings(_env_file=None, **values)


def make_service(respond, **settings_overrides) -> CrowdSecService:
    return CrowdSecService(
        make_settings(**settings_overrides),
        transport=httpx.MockTransport(respond),
    )


async def test_get_decisions_parses_typed_decisions():
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[DECISION_JSON])

    service = make_service(respond)
    decisions = await service.get_decisions()
    assert decisions == [
        Decision(
            id=42,
            origin="cscli",
            type="ban",
            scope="Ip",
            value="1.2.3.4",
            duration="3h59m",
            scenario="manual ban",
        )
    ]
    await service.aclose()


async def test_get_decisions_null_body_returns_empty_list():
    def respond(request: httpx.Request) -> httpx.Response:
        # LAPI returns JSON null when no decisions match
        return httpx.Response(200, content=b"null", headers={"content-type": "application/json"})

    service = make_service(respond)
    assert await service.get_decisions() == []
    await service.aclose()


async def test_get_decisions_sends_bouncer_key_and_filters():
    seen: dict = {}

    def respond(request: httpx.Request) -> httpx.Response:
        seen["headers"] = request.headers
        seen["url"] = request.url
        return httpx.Response(200, json=[])

    service = make_service(respond)
    await service.get_decisions(ip="1.2.3.4", origins="cscli,crowdsec")
    assert seen["headers"]["X-Api-Key"] == "bouncer-key"
    assert seen["url"].params["ip"] == "1.2.3.4"
    assert seen["url"].params["origins"] == "cscli,crowdsec"
    assert seen["url"].path == "/v1/decisions"
    await service.aclose()


async def test_get_decisions_for_ip_filters_on_ip():
    seen: dict = {}

    def respond(request: httpx.Request) -> httpx.Response:
        seen["params"] = request.url.params
        return httpx.Response(200, json=[])

    service = make_service(respond)
    await service.get_decisions_for_ip("10.0.0.1")
    assert seen["params"]["ip"] == "10.0.0.1"
    await service.aclose()


async def test_rejected_bouncer_key_raises_auth_error():
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "forbidden"})

    service = make_service(respond)
    with pytest.raises(CrowdSecAuthError):
        await service.get_decisions()
    await service.aclose()


async def test_lapi_5xx_raises_unavailable_error():
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502)

    service = make_service(respond)
    with pytest.raises(CrowdSecUnavailableError):
        await service.get_decisions()
    await service.aclose()


async def test_connection_failure_raises_unavailable_error():
    def respond(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    service = make_service(respond)
    with pytest.raises(CrowdSecUnavailableError):
        await service.get_decisions()
    await service.aclose()


async def test_ping_true_when_reachable_false_when_not():
    def ok(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[])

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    up_service = make_service(ok)
    down_service = make_service(down)
    assert await up_service.ping() is True
    assert await down_service.ping() is False
    await up_service.aclose()
    await down_service.aclose()


async def test_unknown_extra_fields_are_ignored():
    def respond(request: httpx.Request) -> httpx.Response:
        payload = [{**DECISION_JSON, "simulated": False, "until": "2026-01-01T00:00:00Z"}]
        return httpx.Response(200, content=json.dumps(payload), headers={"content-type": "application/json"})

    service = make_service(respond)
    decisions = await service.get_decisions()
    assert decisions[0].simulated is False
    assert decisions[0].value == "1.2.3.4"
    await service.aclose()


def test_constructing_without_read_credentials_raises():
    with pytest.raises(CrowdSecAuthError):
        CrowdSecService(CrowdSecSettings(_env_file=None))
