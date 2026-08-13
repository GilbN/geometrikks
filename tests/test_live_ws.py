"""Wire-format conversion + WS streaming behavior."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import TYPE_CHECKING, cast

import pytest
from litestar import Litestar
from litestar.channels import ChannelsPlugin
from litestar.channels.backends.memory import MemoryChannelsBackend
from litestar.exceptions import WebSocketDisconnect
from litestar.testing import TestClient

from geometrikks.domain.realtime.events import LIVE_EVENTS_CHANNEL, record_to_events
from geometrikks.services.logparser.schemas import ParsedAccessLog, ParsedGeoData, ParsedLogRecord

if TYPE_CHECKING:
    from collections.abc import Coroutine
    from typing import Any

TS = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)


def make_record(with_geo: bool = True, with_log: bool = True, hostname: str = "") -> ParsedLogRecord:
    geo = ParsedGeoData(
        latitude=51.5, longitude=-0.09, geohash="gcpvj", country_code="GB",
        country_name="UK", timestamp=TS, city="London",
    ) if with_geo else None
    log = ParsedAccessLog(
        timestamp=TS, ip_address="81.2.69.142", remote_user=None, method="GET",
        url="/x", http_version="1.1", status_code=200, bytes_sent=123,
        referrer=None, user_agent="curl", request_time=0.01,
        upstream_response_time=None, host="example.com", country_code="GB",
        country_name="UK", city="London",
    ) if with_log else None
    return ParsedLogRecord(
        ip_address="81.2.69.142", geo_data=geo, access_log=log, raw_line="x",
        hostname=hostname,
    )


def _live_app(db_available: bool = True) -> tuple[Litestar, ChannelsPlugin]:
    from geometrikks.domain.realtime.controllers import live_feed

    channels = ChannelsPlugin(backend=MemoryChannelsBackend(), channels=[LIVE_EVENTS_CHANNEL])
    app = Litestar(route_handlers=[live_feed], plugins=[channels])
    app.state.db_available = db_available
    return app, channels


def test_ws_streams_batch_frames_from_channel():
    app, channels = _live_app()
    with TestClient(app) as client, client.websocket_connect("/ws/live") as ws:
        for event in record_to_events(make_record()):
            channels.publish(event, LIVE_EVENTS_CHANNEL)
        frame = ws.receive_json(timeout=5)
    assert frame["type"] == "batch"
    assert frame["dropped"] == 0
    assert [e["type"] for e in frame["events"]] == ["geo_event", "access_log"]


def test_ws_hostname_arrives_in_frames():
    """The wire event's hostname (needed for multi-instance ingestion) survives
    the round trip through the channel unchanged."""
    app, channels = _live_app()
    with TestClient(app) as client, client.websocket_connect("/ws/live") as ws:
        for event in record_to_events(make_record(with_log=False, hostname="vps-1")):
            channels.publish(event, LIVE_EVENTS_CHANNEL)
        frame = ws.receive_json(timeout=5)
    assert frame["events"][0]["data"]["hostname"] == "vps-1"


def test_ws_sends_empty_batch_heartbeat_when_idle(monkeypatch):
    """Reverse proxies cut idle sockets (nginx proxy_read_timeout); with no
    events flowing the handler must emit an empty batch frame as a keepalive."""
    from geometrikks.domain.realtime import controllers as live_controller

    monkeypatch.setattr(live_controller, "HEARTBEAT_INTERVAL", 0.3, raising=False)
    app, _channels = _live_app()
    with TestClient(app) as client, client.websocket_connect("/ws/live") as ws:
        frame = ws.receive_json(timeout=5)
    assert frame == {"type": "batch", "events": [], "dropped": 0}


def test_ws_closes_1013_when_db_unavailable():
    """Degraded mode closes with 1013 (try again later) and a usable reason."""
    app, _channels = _live_app(db_available=False)
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws/live") as ws:
                ws.receive_json(timeout=2)
    assert exc_info.value.code == 1013
    assert exc_info.value.detail == "live feed unavailable (database down)"


def test_ws_counts_dropped_events_beyond_frame_cap():
    """Overflow beyond MAX_EVENTS_PER_FRAME is counted, not silently lost."""
    app, channels = _live_app()
    with TestClient(app) as client, client.websocket_connect("/ws/live") as ws:
        # 60 records -> 120 events; the first flush window drains them all,
        # keeps 100 and counts 20 dropped.
        for _ in range(60):
            for event in record_to_events(make_record()):
                channels.publish(event, LIVE_EVENTS_CHANNEL)
        frame = ws.receive_json(timeout=5)
    assert frame["type"] == "batch"
    assert len(frame["events"]) == 100
    assert frame["dropped"] == 20


def test_ws_ignores_unexpected_inbound_frames():
    """Policy: inbound client frames are consumed and ignored; the stream
    keeps flowing on the same connection."""
    app, channels = _live_app()
    with TestClient(app) as client, client.websocket_connect("/ws/live") as ws:
        ws.send_text("unexpected")
        ws.send_json({"also": "unexpected"})
        for event in record_to_events(make_record()):
            channels.publish(event, LIVE_EVENTS_CHANNEL)
        frame = ws.receive_json(timeout=5)
    assert frame["type"] == "batch"
    assert len(frame["events"]) == 2


class FakeSocket:
    """Bare-bones WebSocket standing in for a connected, quiet client."""

    connection_state = "connect"

    def __init__(self, channels: ChannelsPlugin, *, db_available: bool = True) -> None:
        self.app = SimpleNamespace(
            state=SimpleNamespace(db_available=db_available),
            plugins=SimpleNamespace(get=lambda _cls: channels),
        )
        self.sent: list[dict] = []

    async def accept(self) -> None: ...

    async def receive_data(self, mode: str = "text") -> str:
        await asyncio.Event().wait()  # a quiet client never sends
        return ""

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None: ...


class DisconnectingSendSocket(FakeSocket):
    """The client vanishes exactly between the disconnect check and the send."""

    async def send_json(self, data: dict) -> None:
        raise WebSocketDisconnect(detail="client gone")


@pytest.mark.anyio
async def test_ws_disconnect_during_send_is_suppressed_and_cleans_up_subscription():
    """A WebSocketDisconnect raised from send_json travels through AnyIO's
    task group as an ExceptionGroup; the handler must suppress it (not let
    the group escape) and clean up its channel subscription before returning.

    There is no more `unsubscribed` flag to assert on (that was the fake
    ingestion broker's bookkeeping); the observable analogue is that the
    channel's subscriber set is empty again once the handler returns, same
    as the log-broadcaster feed's disconnect test below asserts.
    """
    from geometrikks.domain.realtime.controllers import live_feed

    channels = ChannelsPlugin(backend=MemoryChannelsBackend(), channels=[LIVE_EVENTS_CHANNEL])
    async with channels:
        socket = DisconnectingSendSocket(channels)
        task = asyncio.create_task(cast("Coroutine[Any, Any, None]", live_feed.fn(socket)))
        await asyncio.sleep(0.05)  # let the handler subscribe and enter its loop
        for event in record_to_events(make_record()):
            channels.publish(event, LIVE_EVENTS_CHANNEL)
        await asyncio.wait_for(task, timeout=5)  # must not raise
        assert channels._channels[LIVE_EVENTS_CHANNEL] == set()


@pytest.mark.anyio
async def test_ws_cancellation_still_cleans_up_subscription():
    """Server-side cancellation (shutdown) must run the cleanup path."""
    from geometrikks.domain.realtime.controllers import live_feed

    channels = ChannelsPlugin(backend=MemoryChannelsBackend(), channels=[LIVE_EVENTS_CHANNEL])
    async with channels:
        socket = FakeSocket(channels)
        task = asyncio.create_task(cast("Coroutine[Any, Any, None]", live_feed.fn(socket)))
        await asyncio.sleep(0.05)  # let the handler subscribe and enter its loop
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert channels._channels[LIVE_EVENTS_CHANNEL] == set()


class TestLogsFeed:
    def _make_app(self):
        from geometrikks.domain.realtime.controllers import logs_feed
        return Litestar(route_handlers=[logs_feed])

    def _receive_data_frame(self, ws, publish, timeout: float = 5.0):
        """Publish repeatedly until a non-heartbeat frame arrives.

        The handler subscribes shortly AFTER the handshake completes, so a
        single publish can race the subscribe and be missed; heartbeat frames
        (empty records, dropped=0) are skipped.
        """
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            publish()
            frame = ws.receive_json(timeout=2)
            if frame["records"]:
                return frame
        raise AssertionError("no data frame received")

    def test_streams_published_events(self):
        from geometrikks.server.logging import log_broadcaster
        with TestClient(app=self._make_app()) as client:
            with client.websocket_connect("/ws/logs") as ws:
                frame = self._receive_data_frame(
                    ws,
                    lambda: log_broadcaster.publish_threadsafe(
                        {"timestamp": "t", "level": "info", "event": "hello_ws"}
                    ),
                )
                assert frame["type"] == "log_batch"
                assert any(r.get("event") == "hello_ws" for r in frame["records"])

    def test_level_filter_drops_lower_levels(self):
        from geometrikks.server.logging import log_broadcaster
        with TestClient(app=self._make_app()) as client:
            with client.websocket_connect("/ws/logs?level=warning") as ws:
                def publish():
                    log_broadcaster.publish_threadsafe({"level": "debug", "event": "noise"})
                    log_broadcaster.publish_threadsafe({"level": "error", "event": "boom"})
                frame = self._receive_data_frame(ws, publish)
                events = [r["event"] for r in frame["records"]]
                assert "boom" in events and "noise" not in events

    def test_sends_empty_log_batch_heartbeat_when_idle(self, monkeypatch):
        from geometrikks.domain.realtime import controllers as live_controller

        monkeypatch.setattr(live_controller, "HEARTBEAT_INTERVAL", 0.3, raising=False)
        with TestClient(app=self._make_app()) as client:
            with client.websocket_connect("/ws/logs") as ws:
                frame = ws.receive_json(timeout=5)
        assert frame == {"type": "log_batch", "records": [], "dropped": 0}

    def test_counts_dropped_records_beyond_frame_cap(self, monkeypatch):
        from geometrikks.domain.realtime import controllers as live_controller
        from geometrikks.server.logging import log_broadcaster

        monkeypatch.setattr(live_controller, "MAX_RECORDS_PER_FRAME", 3, raising=False)
        import time

        with TestClient(app=self._make_app()) as client:
            with client.websocket_connect("/ws/logs") as ws:
                deadline = time.time() + 5
                while time.time() < deadline:
                    # A burst larger than the frame cap; retried because a
                    # publish can race the handler's subscribe.
                    for i in range(10):
                        log_broadcaster.publish_threadsafe(
                            {"level": "info", "event": f"burst{i}"}
                        )
                    frame = ws.receive_json(timeout=2)
                    if frame["dropped"]:
                        break
                else:
                    raise AssertionError("no frame with dropped records received")
        assert len(frame["records"]) == 3
        assert frame["dropped"] > 0

    def test_unsubscribes_on_disconnect(self):
        from geometrikks.server.logging import log_broadcaster

        baseline = len(log_broadcaster._subscribers)
        with TestClient(app=self._make_app()) as client:
            with client.websocket_connect("/ws/logs"):
                pass
        assert len(log_broadcaster._subscribers) == baseline
