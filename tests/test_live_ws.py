"""Wire-format conversion + WS streaming behavior."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from litestar import Litestar
from litestar.exceptions import WebSocketDisconnect
from litestar.testing import TestClient

from geometrikks.services.logparser.schemas import ParsedAccessLog, ParsedGeoData, ParsedLogRecord

TS = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)


def make_record(with_geo: bool = True, with_log: bool = True) -> ParsedLogRecord:
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
    )


class TestRecordToEvents:
    def test_full_record_yields_both_events(self):
        from geometrikks.api.v1.live_controller import record_to_events
        events = record_to_events(make_record())
        types = [e["type"] for e in events]
        assert types == ["geo_event", "access_log"]
        geo = events[0]["data"]
        assert geo["latitude"] == 51.5 and geo["country_code"] == "GB"
        log = events[1]["data"]
        assert log["status_code"] == 200 and log["url"] == "/x"
        # Wire format carries the full access-log field set.
        assert set(log) == {
            "timestamp", "ip_address", "remote_user", "method", "url",
            "http_version", "status_code", "bytes_sent", "referrer",
            "user_agent", "request_time", "upstream_response_time", "host",
            "country_code", "country_name", "city",
        }
        assert log["http_version"] == "1.1" and log["user_agent"] == "curl"
        assert log["host"] == "example.com" and log["country_code"] == "GB"

    def test_geo_only_record(self):
        from geometrikks.api.v1.live_controller import record_to_events
        events = record_to_events(make_record(with_log=False))
        assert [e["type"] for e in events] == ["geo_event"]

    def test_malformed_record_yields_nothing(self):
        from geometrikks.api.v1.live_controller import record_to_events
        assert record_to_events(make_record(with_geo=False, with_log=False)) == []


class FakeIngestion:
    """subscribe/unsubscribe stub the handler can drive."""

    def __init__(self) -> None:
        self.queue: asyncio.Queue = asyncio.Queue()
        self.unsubscribed = False

    def subscribe(self, maxsize: int = 1000):
        return self.queue

    def unsubscribe(self, queue) -> None:
        self.unsubscribed = True


def make_app(ingestion) -> Litestar:
    from geometrikks.api.v1.live_controller import live_feed
    app = Litestar(route_handlers=[live_feed])
    app.state.ingestion_service = ingestion
    return app


def test_ws_streams_batch_frames():
    ingestion = FakeIngestion()
    with TestClient(app=make_app(ingestion)) as client:
        with client.websocket_connect("/ws/live") as ws:
            ingestion.queue.put_nowait(make_record())
            frame = ws.receive_json(timeout=5)
    assert frame["type"] == "batch"
    assert frame["dropped"] == 0
    assert [e["type"] for e in frame["events"]] == ["geo_event", "access_log"]
    assert ingestion.unsubscribed is True


def test_ws_sends_empty_batch_heartbeat_when_idle(monkeypatch):
    """Reverse proxies cut idle sockets (nginx proxy_read_timeout); with no
    events flowing the handler must emit an empty batch frame as a keepalive."""
    from geometrikks.api.v1 import live_controller

    monkeypatch.setattr(live_controller, "HEARTBEAT_INTERVAL", 0.3, raising=False)
    ingestion = FakeIngestion()
    with TestClient(app=make_app(ingestion)) as client:
        with client.websocket_connect("/ws/live") as ws:
            frame = ws.receive_json(timeout=5)
    assert frame == {"type": "batch", "events": [], "dropped": 0}
    assert ingestion.unsubscribed is True


def test_ws_closes_when_no_ingestion_service():
    """Degraded mode closes with 1013 (try again later) and a usable reason."""
    with TestClient(app=make_app(None)) as client:
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect("/ws/live") as ws:
                ws.receive_json(timeout=2)
    assert exc_info.value.code == 1013
    assert exc_info.value.detail == "ingestion not running"


def test_ws_counts_dropped_events_beyond_frame_cap():
    """Overflow beyond MAX_EVENTS_PER_FRAME is counted, not silently lost."""
    ingestion = FakeIngestion()
    # 60 prefilled records -> 120 events; the first flush window drains them
    # all, keeps 100 and counts 20 dropped.
    for _ in range(60):
        ingestion.queue.put_nowait(make_record())
    with TestClient(app=make_app(ingestion)) as client:
        with client.websocket_connect("/ws/live") as ws:
            frame = ws.receive_json(timeout=5)
    assert frame["type"] == "batch"
    assert len(frame["events"]) == 100
    assert frame["dropped"] == 20
    assert ingestion.unsubscribed is True


def test_ws_ignores_unexpected_inbound_frames():
    """Policy: inbound client frames are consumed and ignored; the stream
    keeps flowing on the same connection."""
    ingestion = FakeIngestion()
    with TestClient(app=make_app(ingestion)) as client:
        with client.websocket_connect("/ws/live") as ws:
            ws.send_text("unexpected")
            ws.send_json({"also": "unexpected"})
            ingestion.queue.put_nowait(make_record())
            frame = ws.receive_json(timeout=5)
    assert frame["type"] == "batch"
    assert len(frame["events"]) == 2
    assert ingestion.unsubscribed is True


class FakeSocket:
    """Bare-bones WebSocket standing in for a connected, quiet client."""

    def __init__(self, state: SimpleNamespace) -> None:
        self.app = SimpleNamespace(state=state)
        self.sent: list[dict] = []

    async def accept(self) -> None: ...

    async def receive_data(self, mode: str = "text") -> str:
        await asyncio.Event().wait()  # a quiet client never sends
        return ""

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None: ...


@pytest.mark.anyio
async def test_ws_cancellation_still_unsubscribes():
    """Server-side cancellation (shutdown) must run the cleanup path."""
    from geometrikks.api.v1.live_controller import live_feed

    ingestion = FakeIngestion()
    socket = FakeSocket(SimpleNamespace(ingestion_service=ingestion))
    task = asyncio.create_task(live_feed.fn(socket))
    await asyncio.sleep(0.05)  # let the handler subscribe and enter its loop
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert ingestion.unsubscribed is True


class TestLogsFeed:
    def _make_app(self):
        from geometrikks.api.v1.live_controller import logs_feed
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
        from geometrikks.api.v1 import live_controller

        monkeypatch.setattr(live_controller, "HEARTBEAT_INTERVAL", 0.3, raising=False)
        with TestClient(app=self._make_app()) as client:
            with client.websocket_connect("/ws/logs") as ws:
                frame = ws.receive_json(timeout=5)
        assert frame == {"type": "log_batch", "records": [], "dropped": 0}

    def test_counts_dropped_records_beyond_frame_cap(self, monkeypatch):
        from geometrikks.api.v1 import live_controller
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
