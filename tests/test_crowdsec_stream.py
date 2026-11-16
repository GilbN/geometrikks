"""Decision stream: service parsing and the poller's broadcast behavior."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx2
import pytest

from tests.test_crowdsec_service import DECISION_JSON, make_service

pytestmark = pytest.mark.anyio

DELTA = {"dedup": "false", "scopes": "ip,range,country,as"}
STARTUP = {**DELTA, "startup": "true"}


class _StreamResponder:
    """Return each payload in turn for successive /v1/decisions/stream calls."""

    def __init__(self, payloads: list[dict]) -> None:
        self._payloads = payloads
        self.calls: list[dict] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.calls.append({"params": dict(request.url.params), "headers": request.headers})
        return httpx2.Response(
            200, json=self._payloads[min(len(self.calls) - 1, len(self._payloads) - 1)]
        )


def stream_responder(payloads: list[dict]) -> _StreamResponder:
    return _StreamResponder(payloads)


async def test_stream_parses_new_and_deleted():
    respond = stream_responder(
        [{"new": [DECISION_JSON], "deleted": [{**DECISION_JSON, "id": 43, "value": "5.6.7.8"}]}]
    )
    service = make_service(respond)
    delta = await service.get_decisions_stream(startup=True)
    assert [d.value for d in delta.new] == ["1.2.3.4"]
    assert [d.value for d in delta.deleted] == ["5.6.7.8"]
    assert respond.calls[0]["params"] == STARTUP
    assert respond.calls[0]["headers"]["X-Api-Key"] == "bouncer-key"
    await service.aclose()


async def test_stream_handles_null_lists():
    respond = stream_responder([{"new": None, "deleted": None}])
    service = make_service(respond)
    delta = await service.get_decisions_stream(startup=False)
    assert delta.new == [] and delta.deleted == []
    assert respond.calls[0]["params"] == DELTA
    await service.aclose()


# -- poller ----------------------------------------------------------------


def make_poller(service):
    from geometrikks.services.crowdsec.stream import CrowdSecStreamPoller

    return CrowdSecStreamPoller(service)


async def test_first_poll_is_startup_and_silent():
    respond = stream_responder([{"new": [DECISION_JSON], "deleted": None}])
    service = make_service(respond)
    poller = make_poller(service)
    queue = poller.subscribe()

    await poller.poll()
    assert respond.calls[0]["params"] == STARTUP
    # The reachability transition (None -> True) broadcasts, the startup
    # decision snapshot does not: it is state, not news.
    assert queue.get_nowait() == {"type": "crowdsec_status", "lapi_reachable": True}
    assert queue.empty()
    await service.aclose()


async def test_later_polls_broadcast_ip_deltas():
    respond = stream_responder(
        [
            {"new": [{**DECISION_JSON, "id": 45, "value": "5.6.7.8"}], "deleted": None},  # startup poll
            {
                "new": [
                    DECISION_JSON,
                    {**DECISION_JSON, "id": 44, "scope": "Range", "value": "10.0.0.0/24"},
                ],
                "deleted": [{**DECISION_JSON, "id": 45, "value": "5.6.7.8"}],
            },
        ]
    )
    service = make_service(respond)
    poller = make_poller(service)
    queue = poller.subscribe()

    await poller.poll()
    await poller.poll()
    assert respond.calls[1]["params"] == DELTA

    assert queue.get_nowait()["type"] == "crowdsec_status"  # first-poll transition
    frame = queue.get_nowait()
    assert frame["type"] == "crowdsec_decisions"
    # Range-scope decisions are not badgeable; only Ip values broadcast
    assert frame["added"] == [
        {"ip": "1.2.3.4", "type": "ban", "origin": "cscli", "scenario": "manual ban", "duration": "3h59m"}
    ]
    assert frame["deleted"] == [{"ip": "5.6.7.8", "type": "ban", "origin": "cscli"}]
    assert queue.empty()
    await service.aclose()


async def test_stream_frames_carry_canonical_addresses():
    respond = stream_responder(
        [
            {"new": [{**DECISION_JSON, "id": 47, "value": "1:2::3"}], "deleted": None},  # startup poll
            {
                "new": [{**DECISION_JSON, "id": 46, "value": "2001:0db8::1", "type": "captcha"}],
                "deleted": [
                    {**DECISION_JSON, "id": 47, "value": "0001:0002::0003"},
                    {**DECISION_JSON, "id": 48, "value": "not-an-ip"},
                ],
            },
        ]
    )
    service = make_service(respond)
    poller = make_poller(service)
    queue = poller.subscribe()

    await poller.poll()
    await poller.poll()

    assert queue.get_nowait()["type"] == "crowdsec_status"
    frame = queue.get_nowait()
    assert [d["ip"] for d in frame["added"]] == ["2001:db8::1"]
    assert [d["ip"] for d in frame["deleted"]] == ["1:2::3"]
    await service.aclose()


async def test_empty_delta_broadcasts_nothing():
    respond = stream_responder([{"new": None, "deleted": None}])
    service = make_service(respond)
    poller = make_poller(service)
    queue = poller.subscribe()
    await poller.poll()
    await poller.poll()
    assert queue.get_nowait()["type"] == "crowdsec_status"  # first-poll transition
    assert queue.empty()
    await service.aclose()


async def test_poll_survives_lapi_errors():
    def respond(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("boom")

    service = make_service(respond)
    poller = make_poller(service)
    queue = poller.subscribe()
    await poller.poll()  # must not raise
    assert queue.get_nowait() == {"type": "crowdsec_status", "lapi_reachable": False}
    assert queue.empty()
    await service.aclose()


def flaky_responder(failures: int, payload: dict):
    """Raise ConnectError for the first `failures` calls, then return payload."""
    calls = {"n": 0}

    def respond(request: httpx2.Request) -> httpx2.Response:
        calls["n"] += 1
        if calls["n"] <= failures:
            raise httpx2.ConnectError("boom")
        return httpx2.Response(200, json=payload)

    return respond


async def test_poller_tracks_reachability_state():
    respond = flaky_responder(1, {"new": None, "deleted": None})
    service = make_service(respond)
    poller = make_poller(service)
    assert poller.lapi_reachable is None
    assert poller.last_success is None

    await poller.poll()  # fails
    assert poller.lapi_reachable is False
    assert poller.last_success is None

    await poller.poll()  # succeeds
    assert poller.lapi_reachable is True
    assert poller.last_success is not None
    await service.aclose()


async def test_status_frame_only_on_transitions():
    # fail, fail, succeed -> exactly two status frames: False then True
    respond = flaky_responder(2, {"new": None, "deleted": None})
    service = make_service(respond)
    poller = make_poller(service)
    queue = poller.subscribe()

    await poller.poll()
    await poller.poll()
    await poller.poll()

    assert queue.get_nowait() == {"type": "crowdsec_status", "lapi_reachable": False}
    assert queue.get_nowait() == {"type": "crowdsec_status", "lapi_reachable": True}
    assert queue.empty()
    await service.aclose()


async def test_unsubscribe_stops_delivery():
    respond = stream_responder(
        [{"new": None, "deleted": None}, {"new": [DECISION_JSON], "deleted": None}]
    )
    service = make_service(respond)
    poller = make_poller(service)
    queue = poller.subscribe()
    poller.unsubscribe(queue)
    await poller.poll()
    await poller.poll()
    assert queue.empty()
    await service.aclose()


# -- tracked decision set ---------------------------------------------------


def decision(ip: str, kind: str = "ban", **overrides) -> dict:
    return {**DECISION_JSON, "value": ip, "type": kind, **overrides}


def tracked(poller) -> dict[str, set[str]] | None:
    state = poller.ip_decision_types()
    return None if state is None else {ip: set(types) for ip, types in state.items()}


async def test_startup_poll_seeds_the_tracked_set():
    respond = stream_responder([{
        "new": [
            decision("1.2.3.4"),
            decision("1.2.3.4", "captcha", id=43, origin="CAPI"),
            decision("2001:0db8::1", id=44),
            decision("10.0.0.0/24", id=45, scope="Range"),
        ],
        "deleted": [decision("9.9.9.9", id=46)],
    }])
    service = make_service(respond)
    poller = make_poller(service)
    assert poller.ip_decision_types() is None

    await poller.poll()
    assert tracked(poller) == {"1.2.3.4": {"ban", "captcha"}, "2001:db8::1": {"ban"}}
    await service.aclose()


async def test_deltas_delete_before_they_add():
    respond = stream_responder([
        {"new": [decision("1.2.3.4"), decision("1.2.3.4", "captcha", id=43), decision("5.6.7.8", id=44)],
         "deleted": None},
        {"new": [decision("5.6.7.8", id=47)],
         "deleted": [decision("1.2.3.4", id=42), decision("5.6.7.8", id=44)]},
        {"new": None, "deleted": [decision("1.2.3.4", "captcha", id=43)]},
    ])
    service = make_service(respond)
    poller = make_poller(service)

    await poller.poll()
    await poller.poll()
    # The captcha outlives the ban; a ban replaced in the same delta stays.
    assert tracked(poller) == {"1.2.3.4": {"captcha"}, "5.6.7.8": {"ban"}}
    await poller.poll()
    assert tracked(poller) == {"5.6.7.8": {"ban"}}
    await service.aclose()


async def test_an_ip_stays_tracked_until_its_last_decision_of_a_type_goes():
    respond = stream_responder([
        {"new": [decision("1.2.3.4", duration="4h"), decision("1.2.3.4", id=43, duration="1h")], "deleted": None},
        {"new": None, "deleted": [decision("1.2.3.4", id=42)]},
        {"new": None, "deleted": [decision("1.2.3.4", id=43, origin="crowdsec")]},
    ])
    service = make_service(respond)
    poller = make_poller(service)
    queue = poller.subscribe()

    await poller.poll()
    await poller.poll()
    assert tracked(poller) == {"1.2.3.4": {"ban"}}
    await poller.poll()
    assert tracked(poller) == {}

    assert queue.get_nowait()["type"] == "crowdsec_status"
    assert queue.get_nowait() == {
        "type": "crowdsec_decisions", "added": [],
        "deleted": [{"ip": "1.2.3.4", "type": "ban", "origin": "cscli"}],
    }
    assert queue.empty()
    await service.aclose()


async def test_decisions_hold_every_scope_with_the_time_left_now(monkeypatch):
    from geometrikks.services.crowdsec import stream

    respond = stream_responder([{
        "new": [
            decision("1.2.3.4", duration="4h"),
            decision("1.2.3.4", id=43, duration="30s", origin="CAPI"),
            decision("10.0.0.0/24", id=44, scope="Range", duration="1h30m"),
            decision("FR", id=45, scope="Country", duration="6h"),
            decision("5.6.7.8", id=46, duration="0s"),
        ],
        "deleted": None,
    }])
    service = make_service(respond)
    poller = make_poller(service)
    assert poller.decisions() is None
    await poller.poll()

    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.now(tz) + timedelta(minutes=1)

    monkeypatch.setattr(stream, "datetime", Later)
    held = {decision.id: decision.duration for decision in poller.decisions()}
    # The 30s ban ran out, and one with no time left counts as gone.
    assert held == {42: "3h59m0s", 44: "1h29m0s", 45: "5h59m0s"}
    assert [decision.id for decision in poller.decisions(scopes=("Range",))] == [44]
    assert [decision.id for decision in poller.decisions(origins=("CAPI",))] == []
    assert [decision.id for decision in poller.decisions(scopes=("Ip",), origins=("cscli",))] == [42]
    await service.aclose()


async def test_tracked_set_is_withheld_while_the_lapi_is_down():
    calls = {"n": 0}

    def respond(request: httpx2.Request) -> httpx2.Response:
        calls["n"] += 1
        if calls["n"] == 2:
            raise httpx2.ConnectError("boom")
        return httpx2.Response(200, json={"new": [decision("1.2.3.4")], "deleted": None})

    service = make_service(respond)
    poller = make_poller(service)
    await poller.poll()
    assert tracked(poller) == {"1.2.3.4": {"ban"}}
    await poller.poll()
    assert poller.ip_decision_types() is None
    assert poller.decisions() is None
    await poller.poll()
    assert tracked(poller) == {"1.2.3.4": {"ban"}}
    await service.aclose()


async def test_a_blocklist_refresh_is_followed_by_a_full_resync():
    # The refresh deleted id 42 outright, so no delta reports it.
    respond = stream_responder([
        {"new": [decision("1.2.3.4", origin="CAPI")], "deleted": None},
        {"new": [decision("1.2.3.4", id=43, origin="CAPI")], "deleted": None},
        {"new": [decision("1.2.3.4", id=43, origin="CAPI")], "deleted": None},
    ])
    service = make_service(respond)
    poller = make_poller(service)
    queue = poller.subscribe()

    await poller.poll()
    await poller.poll()
    assert [call["params"] for call in respond.calls] == [STARTUP, DELTA, STARTUP]
    assert [held.id for held in poller.decisions()] == [43]
    assert queue.get_nowait()["type"] == "crowdsec_status"
    assert queue.empty()
    await service.aclose()


async def test_a_failed_resync_after_a_blocklist_refresh_is_retried_in_full():
    calls: list[dict] = []
    payloads = [
        {"new": [decision("1.2.3.4", origin="CAPI")], "deleted": None},
        {"new": [decision("1.2.3.4", id=43, origin="CAPI")], "deleted": None},
        None,
        {"new": [decision("1.2.3.4", id=43, origin="CAPI")], "deleted": None},
    ]

    def respond(request: httpx2.Request) -> httpx2.Response:
        calls.append(dict(request.url.params))
        payload = payloads[len(calls) - 1]
        if payload is None:
            raise httpx2.ReadTimeout("lost")
        return httpx2.Response(200, json=payload)

    service = make_service(respond)
    poller = make_poller(service)
    for _ in range(3):
        await poller.poll()

    assert calls == [STARTUP, DELTA, STARTUP, STARTUP]
    assert [held.id for held in poller.decisions()] == [43]
    await service.aclose()


async def test_a_failed_poll_is_followed_by_a_full_resync():
    # The LAPI can move the key's stream position and still fail the
    # response, so the delta it carried never arrives.
    calls: list[dict] = []
    payloads = [
        {"new": [decision("1.2.3.4")], "deleted": None},
        None,
        {"new": [decision("1.2.3.4"), decision("5.6.7.8", id=43)], "deleted": None},
    ]

    def respond(request: httpx2.Request) -> httpx2.Response:
        calls.append(dict(request.url.params))
        payload = payloads[len(calls) - 1]
        if payload is None:
            raise httpx2.ReadTimeout("lost")
        return httpx2.Response(200, json=payload)

    service = make_service(respond)
    poller = make_poller(service)
    queue = poller.subscribe()
    for _ in payloads:
        await poller.poll()

    assert calls == [STARTUP, DELTA, STARTUP]
    assert tracked(poller) == {"1.2.3.4": {"ban"}, "5.6.7.8": {"ban"}}
    frames = [queue.get_nowait() for _ in range(queue.qsize())]
    assert {"type": "crowdsec_decisions", "added": [
        {"ip": "5.6.7.8", "type": "ban", "origin": "cscli", "scenario": "manual ban", "duration": "3h59m"}
    ], "deleted": []} in frames
    await service.aclose()


async def test_first_poll_failure_retries_with_startup():
    respond = flaky_responder(1, {"new": [decision("1.2.3.4")], "deleted": None})
    calls: list[dict] = []

    def recording(request: httpx2.Request) -> httpx2.Response:
        calls.append(dict(request.url.params))
        return respond(request)

    service = make_service(recording)
    poller = make_poller(service)
    await poller.poll()
    await poller.poll()
    assert calls == [STARTUP, STARTUP]
    assert tracked(poller) == {"1.2.3.4": {"ban"}}
    await service.aclose()


async def test_resync_replaces_the_set_and_broadcasts_the_difference():
    from geometrikks.services.crowdsec.stream import CrowdSecStreamPoller

    respond = stream_responder([
        {"new": [decision("1.2.3.4"), decision("5.6.7.8", "captcha", id=43, origin="CAPI")], "deleted": None},
        {"new": [decision("1.2.3.4"), decision("9.9.9.9", id=44, scenario="ssh-bf", duration="1h")],
         "deleted": [decision("5.6.7.8", "captcha", id=43)]},
    ])
    service = make_service(respond)
    poller = CrowdSecStreamPoller(service, resync_seconds=0)
    queue = poller.subscribe()

    await poller.poll()
    await poller.poll()
    assert [call["params"] for call in respond.calls] == [STARTUP, STARTUP]
    assert tracked(poller) == {"1.2.3.4": {"ban"}, "9.9.9.9": {"ban"}}

    assert queue.get_nowait()["type"] == "crowdsec_status"
    assert queue.get_nowait() == {
        "type": "crowdsec_decisions",
        "added": [{"ip": "9.9.9.9", "type": "ban", "origin": "cscli", "scenario": "ssh-bf", "duration": "1h"}],
        "deleted": [{"ip": "5.6.7.8", "type": "captcha", "origin": "CAPI"}],
    }
    assert queue.empty()
    await service.aclose()


async def test_overlapping_polls_run_one_at_a_time():
    import anyio

    in_flight = {"now": 0, "max": 0}

    async def respond(request: httpx2.Request) -> httpx2.Response:
        in_flight["now"] += 1
        in_flight["max"] = max(in_flight["max"], in_flight["now"])
        await anyio.sleep(0.01)
        in_flight["now"] -= 1
        return httpx2.Response(200, json={"new": None, "deleted": None})

    service = make_service(respond)
    poller = make_poller(service)
    async with anyio.create_task_group() as tg:
        for _ in range(3):
            tg.start_soon(poller.poll)
    assert in_flight["max"] == 1
    await service.aclose()


# -- scheduler + websocket wiring ------------------------------------------


async def test_scheduler_registers_stream_poll_job(monkeypatch, tmp_path):
    from unittest.mock import MagicMock

    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import create_scheduler

    monkeypatch.chdir(tmp_path)  # keep a local .env out of Settings()
    poller = object.__new__(__import__("geometrikks.services.crowdsec.stream", fromlist=["CrowdSecStreamPoller"]).CrowdSecStreamPoller)

    with_poller = await create_scheduler(MagicMock(), Settings(_env_file=None), crowdsec_poller=poller)
    poll_job = with_poller.get_job("crowdsec-stream-poll")
    assert poll_job is not None
    # The first poll runs at startup, not one interval later.
    assert poll_job.next_run_time <= datetime.now(UTC)

    without = await create_scheduler(MagicMock(), Settings(_env_file=None))
    assert "crowdsec-stream-poll" not in {job.id for job in without.get_jobs()}


class FakePoller:
    """subscribe/unsubscribe stub the WS handler can drive."""

    lapi_reachable = None  # class attr: existing tests get no initial frame

    def __init__(self) -> None:
        import asyncio

        self.queue: asyncio.Queue = __import__("asyncio").Queue()
        self.unsubscribed = False

    def subscribe(self, maxsize: int = 100):
        return self.queue

    def unsubscribe(self, queue) -> None:
        self.unsubscribed = True


def make_ws_app(poller):
    from litestar import Litestar

    from geometrikks.domain.realtime.controllers import crowdsec_feed

    app = Litestar(route_handlers=[crowdsec_feed])
    app.state.crowdsec_stream_poller = poller
    return app


def test_ws_forwards_decision_frames():
    from litestar.testing import TestClient

    poller = FakePoller()
    frame_in = {"type": "crowdsec_decisions", "added": [{"ip": "1.2.3.4"}], "deleted": []}
    with TestClient(app=make_ws_app(poller)) as client:
        with client.websocket_connect("/ws/crowdsec") as ws:
            poller.queue.put_nowait(frame_in)
            frame = ws.receive_json(timeout=5)
    assert frame == frame_in
    assert poller.unsubscribed is True


def test_ws_sends_empty_delta_heartbeat_when_idle(monkeypatch):
    """Reverse proxies cut idle sockets (nginx proxy_read_timeout); with no
    deltas flowing the handler must emit an empty decisions frame as a
    keepalive. The frontend applies it as a no-op."""
    from litestar.testing import TestClient

    from geometrikks.domain.realtime import controllers as live_controller

    monkeypatch.setattr(live_controller, "HEARTBEAT_INTERVAL", 0.3, raising=False)
    poller = FakePoller()
    with TestClient(app=make_ws_app(poller)) as client:
        with client.websocket_connect("/ws/crowdsec") as ws:
            frame = ws.receive_json(timeout=5)
    assert frame == {"type": "crowdsec_decisions", "added": [], "deleted": []}
    assert poller.unsubscribed is True


def test_ws_closes_without_poller():
    """Degraded mode closes with 1013 (try again later) and a usable reason."""
    from litestar.exceptions import WebSocketDisconnect
    from litestar.testing import TestClient

    with TestClient(app=make_ws_app(None)) as client:
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws/crowdsec") as ws:
                ws.receive_json(timeout=10)
    assert exc_info.value.code == 1013
    assert exc_info.value.detail == "crowdsec stream not running"


def test_ws_sends_initial_status_frame():
    from litestar.testing import TestClient

    poller = FakePoller()
    poller.lapi_reachable = False
    with TestClient(app=make_ws_app(poller)) as client:
        with client.websocket_connect("/ws/crowdsec") as ws:
            frame = ws.receive_json(timeout=5)
    assert frame == {"type": "crowdsec_status", "lapi_reachable": False}
