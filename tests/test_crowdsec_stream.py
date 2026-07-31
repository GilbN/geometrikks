"""Decision stream: service parsing and the poller's broadcast behavior."""
from __future__ import annotations

import httpx

from tests.test_crowdsec_service import DECISION_JSON, make_service


def stream_responder(payloads: list[dict]):
    """Return each payload in turn for successive /v1/decisions/stream calls."""
    calls: list[dict] = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append({"params": dict(request.url.params), "headers": request.headers})
        return httpx.Response(200, json=payloads[min(len(calls) - 1, len(payloads) - 1)])

    respond.calls = calls
    return respond


async def test_stream_parses_new_and_deleted():
    respond = stream_responder(
        [{"new": [DECISION_JSON], "deleted": [{**DECISION_JSON, "id": 43, "value": "5.6.7.8"}]}]
    )
    service = make_service(respond)
    delta = await service.get_decisions_stream(startup=True)
    assert [d.value for d in delta.new] == ["1.2.3.4"]
    assert [d.value for d in delta.deleted] == ["5.6.7.8"]
    assert respond.calls[0]["params"] == {"startup": "true"}
    assert respond.calls[0]["headers"]["X-Api-Key"] == "bouncer-key"
    await service.aclose()


async def test_stream_handles_null_lists():
    respond = stream_responder([{"new": None, "deleted": None}])
    service = make_service(respond)
    delta = await service.get_decisions_stream(startup=False)
    assert delta.new == [] and delta.deleted == []
    assert respond.calls[0]["params"] == {}
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
    assert respond.calls[0]["params"] == {"startup": "true"}
    # The reachability transition (None -> True) broadcasts, the startup
    # decision snapshot does not: it is state, not news.
    assert queue.get_nowait() == {"type": "crowdsec_status", "lapi_reachable": True}
    assert queue.empty()
    await service.aclose()


async def test_later_polls_broadcast_ip_deltas():
    respond = stream_responder(
        [
            {"new": None, "deleted": None},  # startup poll
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
    assert respond.calls[1]["params"] == {}

    assert queue.get_nowait()["type"] == "crowdsec_status"  # first-poll transition
    frame = queue.get_nowait()
    assert frame["type"] == "crowdsec_decisions"
    # Range-scope decisions are not badgeable; only Ip values broadcast
    assert frame["added"] == [
        {"ip": "1.2.3.4", "origin": "cscli", "scenario": "manual ban", "duration": "3h59m"}
    ]
    assert frame["deleted"] == [{"ip": "5.6.7.8", "origin": "cscli"}]
    assert queue.empty()
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
    def respond(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

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

    def respond(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] <= failures:
            raise httpx.ConnectError("boom")
        return httpx.Response(200, json=payload)

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


# -- scheduler + websocket wiring ------------------------------------------


async def test_scheduler_registers_stream_poll_job(monkeypatch, tmp_path):
    from unittest.mock import MagicMock

    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import create_scheduler

    monkeypatch.chdir(tmp_path)  # keep a local .env out of Settings()
    poller = object.__new__(__import__("geometrikks.services.crowdsec.stream", fromlist=["CrowdSecStreamPoller"]).CrowdSecStreamPoller)

    with_poller = await create_scheduler(MagicMock(), Settings(_env_file=None), crowdsec_poller=poller)
    assert "crowdsec-stream-poll" in {job.id for job in with_poller.get_jobs()}

    without = await create_scheduler(MagicMock(), Settings(_env_file=None))
    assert "crowdsec-stream-poll" not in {job.id for job in without.get_jobs()}


class FakePoller:
    """subscribe/unsubscribe stub the WS handler can drive."""

    lapi_reachable = None  # class attr: existing tests get no initial frame

    def __init__(self) -> None:
        import asyncio

        self.queue: "asyncio.Queue" = __import__("asyncio").Queue()
        self.unsubscribed = False

    def subscribe(self, maxsize: int = 100):
        return self.queue

    def unsubscribe(self, queue) -> None:
        self.unsubscribed = True


def make_ws_app(poller):
    from litestar import Litestar

    from geometrikks.api.v1.live_controller import crowdsec_feed

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

    from geometrikks.api.v1 import live_controller

    monkeypatch.setattr(live_controller, "HEARTBEAT_INTERVAL", 0.3, raising=False)
    poller = FakePoller()
    with TestClient(app=make_ws_app(poller)) as client:
        with client.websocket_connect("/ws/crowdsec") as ws:
            frame = ws.receive_json(timeout=5)
    assert frame == {"type": "crowdsec_decisions", "added": [], "deleted": []}
    assert poller.unsubscribed is True


def test_ws_closes_without_poller():
    import pytest
    from litestar.exceptions import WebSocketDisconnect
    from litestar.testing import TestClient

    with TestClient(app=make_ws_app(None)) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/crowdsec") as ws:
                ws.receive_json(timeout=2)


def test_ws_sends_initial_status_frame():
    from litestar.testing import TestClient

    poller = FakePoller()
    poller.lapi_reachable = False
    with TestClient(app=make_ws_app(poller)) as client:
        with client.websocket_connect("/ws/crowdsec") as ws:
            frame = ws.receive_json(timeout=5)
    assert frame == {"type": "crowdsec_status", "lapi_reachable": False}
