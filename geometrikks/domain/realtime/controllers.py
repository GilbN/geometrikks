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

Subscription lifecycle, batching, heartbeats, and the transport loop live in
stream.py; this module owns each feed's event conversion, filters, snapshot
frames, and cadences.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from litestar import WebSocket, websocket

from geometrikks.domain.realtime.stream import (
    batched_frames,
    close_service_unavailable,
    passthrough_frames,
    stream_json_frames,
    subscription,
)
from geometrikks.server import runtime
from geometrikks.server.logging import get_logger, log_broadcaster, register_success_level
from geometrikks.services.logparser.schemas import ParsedLogRecord

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

    from geometrikks.domain.realtime.stream import Frame

logger = get_logger(__name__)

FLUSH_INTERVAL = 0.15          # seconds -> ~6.7 frames/s, under the ~10/s cap
MAX_EVENTS_PER_FRAME = 100
# Reverse proxies cut idle upstream sockets (nginx proxy_read_timeout defaults
# to 60s; SWAG ships 240s). All handlers are send-only and silent when no
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


@websocket("/ws/crowdsec", tags=["Live Feed"])
async def crowdsec_feed(socket: WebSocket) -> None:
    """Stream CrowdSec ban/unban deltas from the decision-stream poller.

    One JSON frame per delta:
      {"type": "crowdsec_decisions", "added": [...], "deleted": [...]}
    LAPI reachability transitions (and one snapshot on connect):
      {"type": "crowdsec_status", "lapi_reachable": bool}
    Auth: same session-authenticated handshake as /ws/live.
    """
    poller = runtime.get_crowdsec_poller(socket.app)
    await socket.accept()
    if poller is None:
        await close_service_unavailable(
            socket, endpoint="/ws/crowdsec", reason="crowdsec stream not running"
        )
        return

    async def stream() -> AsyncGenerator[Frame]:
        async with subscription(poller, endpoint="/ws/crowdsec") as queue:
            # A freshly loaded page must not wait for the next reachability
            # transition to learn the current state.
            if poller.lapi_reachable is not None:
                yield {"type": "crowdsec_status", "lapi_reachable": poller.lapi_reachable}
            async for frame in passthrough_frames(
                queue,
                heartbeat_interval=HEARTBEAT_INTERVAL,
                make_heartbeat=lambda: {
                    "type": "crowdsec_decisions", "added": [], "deleted": []
                },
            ):
                yield frame

    await stream_json_frames(socket, stream())


@websocket("/ws/live", tags=["Live Feed"])
async def live_feed(socket: WebSocket) -> None:
    """Stream committed ingestion events, batched and coalesced."""
    ingestion = runtime.get_ingestion_service(socket.app)
    await socket.accept()
    if ingestion is None:
        await close_service_unavailable(
            socket, endpoint="/ws/live", reason="ingestion not running"
        )
        return

    async def stream() -> AsyncGenerator[Frame]:
        async with subscription(ingestion, endpoint="/ws/live") as queue:
            async for frame in batched_frames(
                queue,
                flush_interval=FLUSH_INTERVAL,
                max_items=MAX_EVENTS_PER_FRAME,
                heartbeat_interval=HEARTBEAT_INTERVAL,
                expand=record_to_events,
                make_frame=lambda events, dropped: {
                    "type": "batch", "events": events, "dropped": dropped
                },
            ):
                yield frame

    await stream_json_frames(socket, stream())


LOG_FLUSH_INTERVAL = 0.25
MAX_RECORDS_PER_FRAME = 200


def _min_levelno(level_name: str | None) -> int:
    """Numeric threshold for the optional ?level= filter (default: everything)."""
    if not level_name:
        return 0
    register_success_level()
    mapping = logging.getLevelNamesMapping()
    return mapping.get(level_name.upper(), 0)


@websocket("/ws/logs", tags=["Live Feed"])
async def logs_feed(socket: WebSocket) -> None:
    """Stream application log events, batched and coalesced.

    One JSON frame per flush: {"type": "log_batch", "records": [...], "dropped": n}
    Auth: same session-authenticated handshake as /ws/live.
    """
    await socket.accept()
    log_broadcaster.bind_loop(asyncio.get_running_loop())
    min_levelno = _min_levelno(socket.query_params.get("level"))
    register_success_level()
    level_names = logging.getLevelNamesMapping()

    def at_or_above_level(record: dict[str, Any]) -> tuple[dict[str, Any], ...]:
        levelno = level_names.get(str(record.get("level", "")).upper(), 0)
        return (record,) if levelno >= min_levelno else ()

    async def stream() -> AsyncGenerator[Frame]:
        async with subscription(log_broadcaster, endpoint="/ws/logs") as queue:
            async for frame in batched_frames(
                queue,
                flush_interval=LOG_FLUSH_INTERVAL,
                max_items=MAX_RECORDS_PER_FRAME,
                heartbeat_interval=HEARTBEAT_INTERVAL,
                expand=at_or_above_level,
                make_frame=lambda records, dropped: {
                    "type": "log_batch", "records": records, "dropped": dropped
                },
            ):
                yield frame

    await stream_json_frames(socket, stream())
