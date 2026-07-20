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


# -- write path (machine JWT) ----------------------------------------------


class LapiWriteFake:
    """Routes login/alerts/decisions requests like a real LAPI."""

    def __init__(self, *, login_status: int = 200, expire_first_token: bool = False):
        self.login_calls = 0
        self.alert_payloads: list = []
        self.delete_params: list = []
        self.auth_headers: list[str | None] = []
        self._login_status = login_status
        self._expire_first_token = expire_first_token

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/watchers/login":
            self.login_calls += 1
            if self._login_status != 200:
                return httpx.Response(self._login_status, json={"message": "denied"})
            return httpx.Response(200, json={"token": f"jwt-{self.login_calls}", "expire": "2099-01-01T00:00:00Z"})
        self.auth_headers.append(request.headers.get("Authorization"))
        # Simulate an expired first token: 401 until re-login issues jwt-2
        if self._expire_first_token and request.headers.get("Authorization") == "Bearer jwt-1":
            return httpx.Response(401, json={"message": "token expired"})
        if request.url.path == "/v1/alerts" and request.method == "POST":
            self.alert_payloads.append(json.loads(request.content))
            return httpx.Response(201, json=["1"])
        if request.url.path == "/v1/decisions" and request.method == "DELETE":
            self.delete_params.append(dict(request.url.params))
            return httpx.Response(200, json={"nbDeleted": "2"})
        return httpx.Response(404)


def write_settings() -> dict:
    return {"machine_id": "geometrikks", "machine_password": "machine-pass"}


async def test_ban_ip_logs_in_and_posts_alert():
    lapi = LapiWriteFake()
    service = make_service(lapi, **write_settings())
    await service.ban_ip("1.2.3.4", duration="24h", reason="test ban")

    assert lapi.login_calls == 1
    assert lapi.auth_headers == ["Bearer jwt-1"]
    (alerts,) = lapi.alert_payloads
    (alert,) = alerts
    assert alert["source"] == {"scope": "Ip", "value": "1.2.3.4", "ip": "1.2.3.4"}
    (decision,) = alert["decisions"]
    assert decision["type"] == "ban"
    assert decision["value"] == "1.2.3.4"
    assert decision["duration"] == "24h"
    assert decision["origin"] == "geometrikks"
    assert "test ban" in alert["message"]
    await service.aclose()


async def test_ban_ip_uses_default_duration():
    lapi = LapiWriteFake()
    service = make_service(lapi, **write_settings())
    await service.ban_ip("1.2.3.4")
    (alerts,) = lapi.alert_payloads
    assert alerts[0]["decisions"][0]["duration"] == "4h"
    await service.aclose()


async def test_machine_token_is_cached_across_calls():
    lapi = LapiWriteFake()
    service = make_service(lapi, **write_settings())
    await service.ban_ip("1.2.3.4")
    await service.unban_ip("1.2.3.4")
    assert lapi.login_calls == 1
    await service.aclose()


async def test_expired_token_triggers_single_relogin_retry():
    lapi = LapiWriteFake(expire_first_token=True)
    service = make_service(lapi, **write_settings())
    deleted = await service.unban_ip("1.2.3.4")
    assert deleted == 2
    assert lapi.login_calls == 2
    assert lapi.auth_headers == ["Bearer jwt-1", "Bearer jwt-2"]
    await service.aclose()


async def test_unban_ip_parses_string_nb_deleted():
    lapi = LapiWriteFake()
    service = make_service(lapi, **write_settings())
    assert await service.unban_ip("5.6.7.8") == 2
    assert lapi.delete_params == [{"ip": "5.6.7.8"}]
    await service.aclose()


async def test_write_without_machine_credentials_raises_auth_error():
    service = make_service(LapiWriteFake())  # bouncer key only
    with pytest.raises(CrowdSecAuthError):
        await service.ban_ip("1.2.3.4")
    await service.aclose()


async def test_rejected_machine_login_raises_auth_error():
    service = make_service(LapiWriteFake(login_status=403), **write_settings())
    with pytest.raises(CrowdSecAuthError):
        await service.ban_ip("1.2.3.4")
    await service.aclose()


# -- alert history (machine JWT) -------------------------------------------

ALERT_JSON = {
    "id": 7,
    "scenario": "crowdsecurity/ssh-bf",
    "message": "Ip 1.2.3.4 performed ssh bruteforce",
    "events_count": 6,
    "created_at": "2026-07-20T10:00:00Z",
    "machine_id": "gateway",
    "source": {"scope": "Ip", "value": "1.2.3.4", "ip": "1.2.3.4", "cn": "NO", "as_name": "Telenor"},
    "decisions": [
        {"id": 9, "origin": "crowdsec", "type": "ban", "scope": "Ip",
         "value": "1.2.3.4", "duration": "4h", "scenario": "crowdsecurity/ssh-bf"},
    ],
}


class LapiAlertsFake(LapiWriteFake):
    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/alerts" and request.method == "GET":
            self.auth_headers.append(request.headers.get("Authorization"))
            self.alert_params = dict(request.url.params)
            return httpx.Response(200, json=[ALERT_JSON, {**ALERT_JSON, "id": 8, "decisions": None}])
        return super().__call__(request)


async def test_get_alerts_uses_machine_auth_and_parses():
    lapi = LapiAlertsFake()
    service = make_service(lapi, **write_settings())
    alerts = await service.get_alerts(limit=25, since="24h")

    assert lapi.auth_headers == ["Bearer jwt-1"]
    assert lapi.alert_params == {"limit": "25", "since": "24h"}
    first, second = alerts
    assert first.scenario == "crowdsecurity/ssh-bf"
    assert first.source.value == "1.2.3.4"
    assert first.source.cn == "NO"
    assert first.machine_id == "gateway"
    assert [d.value for d in first.decisions] == ["1.2.3.4"]
    assert second.decisions == []  # LAPI nulls the list on alerts without decisions
    await service.aclose()


async def test_get_alerts_without_machine_credentials_raises():
    service = make_service(LapiAlertsFake())
    with pytest.raises(CrowdSecAuthError):
        await service.get_alerts()
    await service.aclose()
