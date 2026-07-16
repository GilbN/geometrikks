"""Wire-format conversion + WS streaming behavior."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from litestar import Litestar
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


def test_ws_closes_when_no_ingestion_service():
    import pytest
    from litestar.exceptions import WebSocketDisconnect  # NOT starlette — litestar has no starlette dependency

    with TestClient(app=make_app(None)) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws/live") as ws:
                ws.receive_json(timeout=2)
