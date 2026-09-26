"""CrowdSecService read path: parsing, headers, error translation."""
from __future__ import annotations

import json
from typing import Any

import httpx2
import pytest

from geometrikks.config.settings import CrowdSecSettings
from geometrikks.services.crowdsec import (
    AlertContext,
    CrowdSecAuthError,
    CrowdSecService,
    CrowdSecUnavailableError,
    CrowdSecUnsupportedError,
    Decision,
)

pytestmark = pytest.mark.anyio

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
    values: dict[str, Any] = {
        "lapi_url": "http://crowdsec:8080",
        "bouncer_api_key": "bouncer-key",
        **overrides,
    }
    return CrowdSecSettings(_env_file=None, **values)


def make_service(respond, **settings_overrides) -> CrowdSecService:
    return CrowdSecService(
        make_settings(**settings_overrides),
        transport=httpx2.MockTransport(respond),
    )


async def test_get_decisions_parses_typed_decisions():
    def respond(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=[DECISION_JSON])

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
    def respond(request: httpx2.Request) -> httpx2.Response:
        # LAPI returns JSON null when no decisions match
        return httpx2.Response(200, content=b"null", headers={"content-type": "application/json"})

    service = make_service(respond)
    assert await service.get_decisions() == []
    await service.aclose()


async def test_get_decisions_sends_bouncer_key_and_filters():
    seen: dict = {}

    def respond(request: httpx2.Request) -> httpx2.Response:
        seen["headers"] = request.headers
        seen["url"] = request.url
        return httpx2.Response(200, json=[])

    service = make_service(respond)
    await service.get_decisions(ip="1.2.3.4", origins="cscli,crowdsec")
    assert seen["headers"]["X-Api-Key"] == "bouncer-key"
    assert seen["url"].params["ip"] == "1.2.3.4"
    assert seen["url"].params["origins"] == "cscli,crowdsec"
    assert seen["url"].path == "/v1/decisions"
    await service.aclose()


async def test_get_decisions_for_ip_filters_on_ip():
    seen: dict = {}

    def respond(request: httpx2.Request) -> httpx2.Response:
        seen["params"] = request.url.params
        return httpx2.Response(200, json=[])

    service = make_service(respond)
    await service.get_decisions_for_ip("10.0.0.1")
    assert seen["params"]["ip"] == "10.0.0.1"
    await service.aclose()


async def test_rejected_bouncer_key_raises_auth_error():
    def respond(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(403, json={"message": "forbidden"})

    service = make_service(respond)
    with pytest.raises(CrowdSecAuthError):
        await service.get_decisions()
    await service.aclose()


async def test_lapi_5xx_raises_unavailable_error():
    def respond(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(502)

    service = make_service(respond)
    with pytest.raises(CrowdSecUnavailableError):
        await service.get_decisions()
    await service.aclose()


async def test_connection_failure_raises_unavailable_error():
    def respond(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("boom")

    service = make_service(respond)
    with pytest.raises(CrowdSecUnavailableError):
        await service.get_decisions()
    await service.aclose()


async def test_ping_true_when_reachable_false_when_not():
    def ok(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=[])

    def down(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("boom")

    up_service = make_service(ok)
    down_service = make_service(down)
    assert await up_service.ping() is True
    assert await down_service.ping() is False
    await up_service.aclose()
    await down_service.aclose()


async def test_unknown_extra_fields_are_ignored():
    def respond(request: httpx2.Request) -> httpx2.Response:
        payload = [{**DECISION_JSON, "simulated": False, "until": "2026-01-01T00:00:00Z"}]
        return httpx2.Response(200, content=json.dumps(payload), headers={"content-type": "application/json"})

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

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/v1/watchers/login":
            self.login_calls += 1
            if self._login_status != 200:
                return httpx2.Response(self._login_status, json={"message": "denied"})
            return httpx2.Response(200, json={"token": f"jwt-{self.login_calls}", "expire": "2099-01-01T00:00:00Z"})
        self.auth_headers.append(request.headers.get("Authorization"))
        # Simulate an expired first token: 401 until re-login issues jwt-2
        if self._expire_first_token and request.headers.get("Authorization") == "Bearer jwt-1":
            return httpx2.Response(401, json={"message": "token expired"})
        if request.url.path == "/v1/alerts" and request.method == "POST":
            self.alert_payloads.append(json.loads(request.content))
            return httpx2.Response(201, json=["1"])
        if request.url.path == "/v1/decisions" and request.method == "DELETE":
            self.delete_params.append(dict(request.url.params))
            return httpx2.Response(200, json={"nbDeleted": "2"})
        return httpx2.Response(404)


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
    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/v1/alerts" and request.method == "GET":
            self.auth_headers.append(request.headers.get("Authorization"))
            self.alert_params = dict(request.url.params)
            return httpx2.Response(200, json=[ALERT_JSON, {**ALERT_JSON, "id": 8, "decisions": None}])
        return super().__call__(request)


async def test_get_alerts_uses_machine_auth_and_parses():
    lapi = LapiAlertsFake()
    service = make_service(lapi, **write_settings())
    alerts = await service.get_alerts(limit=25, since="24h")

    assert lapi.auth_headers == ["Bearer jwt-1"]
    assert lapi.alert_params == {"limit": "25", "since": "24h", "include_capi": "false"}
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


# -- alert detail (machine JWT) --------------------------------------------

# Trimmed from a real LAPI payload. Context values are JSON arrays encoded
# as strings, event timestamps use Go's default format, and an expired
# decision stays on the alert with a negative duration.
ALERT_DETAIL_JSON = {
    "id": 10908,
    "kind": "crowdsec",
    "scenario": "crowdsecurity/http-probing",
    "message": "Ip 45.148.10.59 performed 'crowdsecurity/http-probing'",
    "events_count": 11,
    "created_at": "2026-09-20T05:43:23Z",
    "start_at": "2026-09-20T05:43:18Z",
    "stop_at": "2026-09-20T05:43:20Z",
    "machine_id": "localhost",
    "simulated": False,
    "labels": None,
    "source": {
        "scope": "Ip", "value": "45.148.10.59", "ip": "45.148.10.59", "cn": "NL",
        "as_name": "Techoff Srv Limited", "as_number": "48090",
        "range": "45.148.10.0/24", "latitude": 52.3759, "longitude": 4.8975,
    },
    "meta": [
        {"key": "status", "value": "[\"404\"]"},
        {"key": "method", "value": "[\"GET\",\"POST\"]"},
        {"key": "target_uri", "value": "[\"/wp-json/\",\"/index.php?rest_route=/batch/v1\"]"},
    ],
    "events": [
        {
            "timestamp": "2026-09-20 05:43:18 +0000 UTC",
            "meta": [
                {"key": "http_path", "value": "/wp-json/"},
                {"key": "http_status", "value": "404"},
                {"key": "http_verb", "value": "GET"},
                {"key": "timestamp", "value": "2026-09-20T05:43:18Z"},
            ],
        },
    ],
    "decisions": [
        {"id": 7509906, "origin": "crowdsec", "type": "ban", "scope": "Ip",
         "value": "45.148.10.59", "duration": "-1h37m37s", "simulated": False,
         "scenario": "crowdsecurity/http-probing"},
    ],
}


class LapiAlertDetailFake(LapiWriteFake):
    def __init__(self, alert: dict | None):
        super().__init__()
        self._alert = alert
        self.paths: list[str] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.path.startswith("/v1/alerts/") and request.method == "GET":
            self.paths.append(request.url.path)
            if self._alert is None:
                return httpx2.Response(404, json={"message": "object not found"})
            return httpx2.Response(200, json=self._alert)
        return super().__call__(request)


async def test_get_alert_fetches_by_id_and_parses_detail_fields():
    lapi = LapiAlertDetailFake(ALERT_DETAIL_JSON)
    service = make_service(lapi, **write_settings())
    alert = await service.get_alert(10908)

    assert lapi.paths == ["/v1/alerts/10908"]
    assert alert is not None
    assert alert.kind == "crowdsec"
    assert alert.start_at == "2026-09-20T05:43:18Z"
    assert alert.stop_at == "2026-09-20T05:43:20Z"
    assert alert.simulated is False
    assert alert.source.as_number == "48090"
    assert alert.source.range == "45.148.10.0/24"
    await service.aclose()


async def test_get_alert_decodes_context_values_from_json_strings():
    service = make_service(LapiAlertDetailFake(ALERT_DETAIL_JSON), **write_settings())
    alert = await service.get_alert(10908)
    assert alert is not None
    assert alert.context == [
        AlertContext(key="status", values=["404"]),
        AlertContext(key="method", values=["GET", "POST"]),
        AlertContext(key="target_uri", values=["/wp-json/", "/index.php?rest_route=/batch/v1"]),
    ]
    await service.aclose()


async def test_get_alert_keeps_undecodable_context_value_as_is():
    raw = {**ALERT_DETAIL_JSON, "meta": [{"key": "note", "value": "not json"}]}
    service = make_service(LapiAlertDetailFake(raw), **write_settings())
    alert = await service.get_alert(10908)
    assert alert is not None
    assert alert.context == [AlertContext(key="note", values=["not json"])]
    await service.aclose()


async def test_get_alert_flattens_event_meta_and_prefers_its_rfc3339_timestamp():
    service = make_service(LapiAlertDetailFake(ALERT_DETAIL_JSON), **write_settings())
    alert = await service.get_alert(10908)
    assert alert is not None
    (event,) = alert.events
    assert event.timestamp == "2026-09-20T05:43:18Z"
    assert event.meta["http_path"] == "/wp-json/"
    assert event.meta["http_verb"] == "GET"
    await service.aclose()


async def test_get_alert_tolerates_null_events_meta_and_decisions():
    raw = {**ALERT_DETAIL_JSON, "events": None, "meta": None, "decisions": None}
    service = make_service(LapiAlertDetailFake(raw), **write_settings())
    alert = await service.get_alert(10908)
    assert alert is not None
    assert (alert.events, alert.context, alert.decisions) == ([], [], [])
    await service.aclose()


async def test_get_alert_returns_none_when_lapi_has_no_such_alert():
    service = make_service(LapiAlertDetailFake(None), **write_settings())
    assert await service.get_alert(999) is None
    await service.aclose()


async def test_decision_with_negative_duration_is_expired():
    service = make_service(LapiAlertDetailFake(ALERT_DETAIL_JSON), **write_settings())
    alert = await service.get_alert(10908)
    assert alert is not None
    assert [d.expired for d in alert.decisions] == [True]
    live = Decision(id=1, origin="cscli", type="ban", scope="Ip", value="1.2.3.4",
                    duration="3h59m", scenario="manual ban")
    assert live.expired is False
    await service.aclose()


async def test_get_alerts_excludes_capi_blocklist_pulls():
    lapi = LapiAlertsFake()
    service = make_service(lapi, **write_settings())
    await service.get_alerts(limit=25)
    assert lapi.alert_params["include_capi"] == "false"
    await service.aclose()


async def test_get_alerts_can_ask_for_alerts_with_a_live_decision_only():
    lapi = LapiAlertsFake()
    service = make_service(lapi, **write_settings())
    await service.get_alerts(ip="1.2.3.4", has_active_decision=True)
    assert lapi.alert_params["has_active_decision"] == "true"
    await service.get_alerts(ip="1.2.3.4")
    assert "has_active_decision" not in lapi.alert_params
    await service.aclose()


async def test_alert_meta_entries_without_a_value_or_key_do_not_break_parsing():
    """CrowdSec marshals both meta fields with omitempty, so an empty user
    agent arrives as ``{"key": "http_user_agent"}``."""
    raw = {
        **ALERT_DETAIL_JSON,
        "meta": [{"key": "user_agent"}, {"value": "[\"orphan\"]"}, {"key": "status", "value": "[\"404\"]"}],
        "events": [
            {
                "timestamp": "2026-09-20 05:43:18 +0000 UTC",
                "meta": [{"key": "http_user_agent"}, {"value": "orphan"}, {"key": "http_path", "value": "/x"}],
            }
        ],
    }
    service = make_service(LapiAlertDetailFake(raw), **write_settings())
    alert = await service.get_alert(10908)
    assert alert is not None
    assert alert.context == [
        AlertContext(key="user_agent", values=[]),
        AlertContext(key="status", values=["404"]),
    ]
    (event,) = alert.events
    assert event.meta == {"http_user_agent": "", "http_path": "/x"}
    assert event.timestamp == "2026-09-20T05:43:18+00:00"
    await service.aclose()


@pytest.mark.parametrize(("timestamp", "expected"), [
    ("2026-09-20 05:43:18 +0000 UTC", "2026-09-20T05:43:18+00:00"),
    ("2026-09-20 05:43:18.123456789 +0200 CEST", "2026-09-20T05:43:18.123456+02:00"),
    ("2026-09-20 05:43:18 -0430 -0430", "2026-09-20T05:43:18-04:30"),
    ("2026-09-20T05:43:18Z", "2026-09-20T05:43:18Z"),
    ("2026-99-20 05:43:18 +0000 UTC", "2026-99-20 05:43:18 +0000 UTC"),
    ("", ""),
])
async def test_alert_fallback_event_timestamps(timestamp, expected):
    raw = {
        **ALERT_DETAIL_JSON,
        "events": [{"timestamp": timestamp, "meta": [{"key": "service", "value": "ssh"}]}],
    }
    service = make_service(LapiAlertDetailFake(raw), **write_settings())
    alert = await service.get_alert(10908)
    assert alert is not None
    assert alert.events[0].timestamp == expected
    await service.aclose()


async def test_one_alert_with_valueless_meta_does_not_break_the_history_list():
    class Fake(LapiAlertsFake):
        def __call__(self, request: httpx2.Request) -> httpx2.Response:
            if request.url.path == "/v1/alerts" and request.method == "GET":
                broken = {**ALERT_JSON, "id": 9, "events": [{"timestamp": "t", "meta": [{"key": "http_user_agent"}]}]}
                return httpx2.Response(200, json=[ALERT_JSON, broken])
            return super().__call__(request)

    service = make_service(Fake(), **write_settings())
    assert [a.id for a in await service.get_alerts()] == [7, 9]
    await service.aclose()


async def test_get_alerts_forwards_kind():
    lapi = LapiAlertsFake()
    service = make_service(lapi, **write_settings())
    await service.get_alerts(kind="bot-detection")
    assert lapi.alert_params["kind"] == "bot-detection"
    await service.get_alerts()
    assert "kind" not in lapi.alert_params
    await service.aclose()


class OldLapiAlertsFake(LapiAlertsFake):
    """A LAPI older than 1.7 answers 400 to the ``kind`` filter."""

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/v1/alerts" and "kind" in request.url.params:
            return httpx2.Response(400, json={"message": "filter parameter 'kind' is unknown"})
        return super().__call__(request)


async def test_get_alerts_kind_on_an_old_lapi_names_the_minimum_version():
    service = make_service(OldLapiAlertsFake(), **write_settings())
    with pytest.raises(CrowdSecUnsupportedError, match="1.7"):
        await service.get_alerts(kind="bot-detection")
    await service.aclose()


async def test_get_alerts_other_400s_still_read_as_unavailable():
    def respond(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/v1/watchers/login":
            return httpx2.Response(200, json={"token": "jwt-1"})
        return httpx2.Response(400, json={"message": "bad since"})

    service = make_service(respond, **write_settings())
    with pytest.raises(CrowdSecUnavailableError):
        await service.get_alerts(since="nope")
    await service.aclose()


# A CrowdSec 1.8.1 bot-detection alert as the LAPI returned it on
# 2026-09-26, with the IP replaced. The challenge writes one event per
# rejection, sets no remediation, and GeoIP-enriches the source itself.
BOT_DETECTION_ALERT_JSON = {
    "created_at": "2026-09-26T12:33:42Z",
    "decisions": None,
    "events": [
        {
            "meta": [
                {
                    "key": "bot_signals",
                    "value": "cdp"
                },
                {
                    "key": "challenge_event",
                    "value": "rejected"
                },
                {
                    "key": "challenge_fail_reason",
                    "value": "request score 100"
                },
                {
                    "key": "fingerprint_bot",
                    "value": "true"
                },
                {
                    "key": "fsid",
                    "value": "FS1_000010000000000000000_00010h02ba_1920x1200c20m32b00011h366c95_f10001111000101111000111111111e00000000p1100h-34daa_0h-3c7c2_1h6d8275_nb6tEurope-Oslo_h3af4_0100h63b845"
                },
                {
                    "key": "http_user_agent",
                    "value": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
                },
                {
                    "key": "log_type",
                    "value": "appsec-challenge"
                },
                {
                    "key": "method",
                    "value": "POST"
                },
                {
                    "key": "os",
                    "value": "Windows"
                },
                {
                    "key": "request_score",
                    "value": "100"
                },
                {
                    "key": "request_score_reasons",
                    "value": "cdp=100"
                },
                {
                    "key": "request_uuid",
                    "value": "b350f54c-2e79-4dc2-af3c-163134d71c47"
                },
                {
                    "key": "service",
                    "value": "appsec"
                },
                {
                    "key": "source_ip",
                    "value": "203.0.113.7"
                },
                {
                    "key": "target_host",
                    "value": "gflix.app"
                },
                {
                    "key": "target_uri",
                    "value": "/"
                }
            ],
            "timestamp": "2026-09-26 12:33:41 +0000 UTC"
        }
    ],
    "events_count": 1,
    "id": 13087,
    "kind": "bot-detection",
    "machine_id": "localhost",
    "message": "WAF bot-detection: 203.0.113.7 rejected by crowdsecurity/rejected-browser-submission (request score 100)",
    "meta": [
        {
            "key": "bot_detected",
            "value": "[\"true\"]"
        },
        {
            "key": "challenge_event",
            "value": "[\"rejected\"]"
        },
        {
            "key": "fail_reason",
            "value": "[\"request score 100\"]"
        },
        {
            "key": "fingerprint_id",
            "value": "[\"FS1_000010000000000000000_00010h02ba_1920x1200c20m32b00011h366c95_f10001111000101111000111111111e00000000p1100h-34daa_0h-3c7c2_1h6d8275_nb6tEurope-Oslo_h3af4_0100h63b845\"]"
        },
        {
            "key": "request_score",
            "value": "[\"100\"]"
        },
        {
            "key": "score_reasons",
            "value": "[\"cdp=100\"]"
        },
        {
            "key": "user_agent",
            "value": "[\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36\"]"
        },
        {
            "key": "target_uri",
            "value": "[\"/\"]"
        },
        {
            "key": "operating_system",
            "value": "[\"Windows\"]"
        }
    ],
    "scenario": "crowdsecurity/rejected-browser-submission",
    "simulated": False,
    "source": {
        "scope": "Ip",
        "value": "203.0.113.7",
        "ip": "203.0.113.7",
        "cn": "NO",
        "as_name": "Telenor Norge AS",
        "as_number": "2119",
        "range": "203.0.113.0/24"
    },
    "start_at": "2026-09-26T12:33:41Z",
    "stop_at": "2026-09-26T12:33:41Z"
}


async def test_get_alert_parses_a_bot_detection_alert():
    service = make_service(LapiAlertDetailFake(BOT_DETECTION_ALERT_JSON), **write_settings())
    alert = await service.get_alert(13087)
    assert alert is not None
    assert alert.kind == "bot-detection"
    assert alert.scenario == "crowdsecurity/rejected-browser-submission"
    assert alert.decisions == []
    assert alert.source.cn == "NO"
    assert alert.source.as_number == "2119"
    context = {entry.key: entry.values for entry in alert.context}
    assert context["request_score"] == ["100"]
    assert context["score_reasons"] == ["cdp=100"]
    assert context["challenge_event"] == ["rejected"]
    (event,) = alert.events
    assert event.timestamp == "2026-09-26T12:33:41+00:00"
    assert event.meta["log_type"] == "appsec-challenge"
    assert event.meta["request_score_reasons"] == "cdp=100"
    assert event.meta["target_host"] == "gflix.app"
    await service.aclose()
