"""Live event feed over WebSocket.

Protocol: one JSON frame per message —
  {"type": "batch", "events": [...], "dropped": n}
Events are converted from post-commit ParsedLogRecords; frames flush every
FLUSH_INTERVAL seconds with at most MAX_EVENTS_PER_FRAME events (overflow is
counted in `dropped` — the browser gets a rate signal instead of melting).
When idle, an empty frame is sent every HEARTBEAT_INTERVAL seconds so reverse
proxies don't cut the socket.

Auth: /ws/ paths are NOT excluded in AUTH_EXCLUDE_PATTERNS, so the session
middleware authenticates the handshake exactly like an API request.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from litestar import WebSocket, websocket
from litestar.exceptions import WebSocketDisconnect

from geometrikks.services.logparser.schemas import ParsedLogRecord

logger = logging.getLogger(__name__)

FLUSH_INTERVAL = 0.15          # seconds -> ~6.7 frames/s, under the ~10/s cap
MAX_EVENTS_PER_FRAME = 100
# Reverse proxies cut idle upstream sockets (nginx proxy_read_timeout defaults
# to 60s; SWAG ships 240s). Both handlers are send-only and silent when no
# events flow, so emit an empty frame of the endpoint's own type as a
# keepalive — existing clients treat it as a no-op and reset their backoff.
HEARTBEAT_INTERVAL = 30.0


def record_to_events(record: ParsedLogRecord) -> list[dict[str, Any]]:
    """Convert one committed record to wire events (0, 1, or 2)."""
    events: list[dict[str, Any]] = []
    if record.geo_data and record.ip_address:
        g = record.geo_data
        events.append({
            "type": "geo_event",
            "data": {
                "timestamp": g.timestamp.isoformat(),
                "ip_address": record.ip_address,
                "latitude": g.latitude,
                "longitude": g.longitude,
                "city": g.city,
                "country_code": g.country_code,
            },
        })
    if record.access_log:
        a = record.access_log
        events.append({
            "type": "access_log",
            "data": {
                "timestamp": a.timestamp.isoformat(),
                "ip_address": a.ip_address,
                "remote_user": a.remote_user,
                "method": a.method,
                "url": a.url,
                "http_version": a.http_version,
                "status_code": a.status_code,
                "bytes_sent": a.bytes_sent,
                "referrer": a.referrer,
                "user_agent": a.user_agent,
                "request_time": a.request_time,
                "upstream_response_time": a.upstream_response_time,
                "host": a.host,
                "country_code": a.country_code,
                "country_name": a.country_name,
                "city": a.city,
            },
        })
    return events


async def _watch_disconnect(socket: WebSocket) -> None:
    """Consume incoming messages so a client disconnect is noticed.

    The handler is send-only; without a reader, a client that disconnects
    while no events are flowing is never observed and its queue stays
    subscribed forever (dead connections accumulate on quiet log files).
    litestar raises WebSocketDisconnect from receive on close.
    """
    while True:
        await socket.receive_data(mode="text")


@websocket("/ws/crowdsec", tags=["Live Feed"])
async def crowdsec_feed(socket: WebSocket) -> None:
    """Stream CrowdSec ban/unban deltas from the decision-stream poller.

    One JSON frame per delta:
      {"type": "crowdsec_decisions", "added": [...], "deleted": [...]}
    Auth: same session-authenticated handshake as /ws/live.
    """
    poller = getattr(socket.app.state, "crowdsec_stream_poller", None)
    await socket.accept()
    if poller is None:
        await socket.close(code=1013, reason="crowdsec stream not running")  # 1013 = try again later
        return

    queue = poller.subscribe()
    watcher = asyncio.create_task(_watch_disconnect(socket))
    try:
        loop = asyncio.get_running_loop()
        last_send = loop.time()
        while not watcher.done():
            try:
                frame = await asyncio.wait_for(queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                if not watcher.done() and loop.time() - last_send >= HEARTBEAT_INTERVAL:
                    await socket.send_json(
                        {"type": "crowdsec_decisions", "added": [], "deleted": []}
                    )
                    last_send = loop.time()
                continue
            if not watcher.done():
                await socket.send_json(frame)
                last_send = loop.time()
    except WebSocketDisconnect:
        pass  # client went away between the watcher check and the send
    finally:
        watcher.cancel()
        with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect):
            await watcher
        poller.unsubscribe(queue)


@websocket("/ws/live", tags=["Live Feed"])
async def live_feed(socket: WebSocket) -> None:
    """Stream committed ingestion events, batched and coalesced."""
    ingestion = getattr(socket.app.state, "ingestion_service", None)
    await socket.accept()
    if ingestion is None:
        await socket.close(code=1013, reason="ingestion not running")  # 1013 = try again later
        return

    queue = ingestion.subscribe()
    watcher = asyncio.create_task(_watch_disconnect(socket))
    try:
        loop = asyncio.get_running_loop()
        last_send = loop.time()
        pending: list[dict[str, Any]] = []
        dropped = 0
        while not watcher.done():
            # Drain until the flush deadline.
            deadline = loop.time() + FLUSH_INTERVAL
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                try:
                    record = await asyncio.wait_for(queue.get(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                for event in record_to_events(record):
                    if len(pending) >= MAX_EVENTS_PER_FRAME:
                        dropped += 1
                    else:
                        pending.append(event)

            if watcher.done():
                break
            if pending or dropped or loop.time() - last_send >= HEARTBEAT_INTERVAL:
                await socket.send_json({"type": "batch", "events": pending, "dropped": dropped})
                pending, dropped = [], 0
                last_send = loop.time()
    except WebSocketDisconnect:
        pass  # client went away between the watcher check and the send
    finally:
        watcher.cancel()
        with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect):
            await watcher  # retrieve its exception so no "never retrieved" warning
        ingestion.unsubscribe(queue)
