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
stream.py; live-feed event conversion lives in events.py. This module owns
the handlers themselves, filters, snapshot frames, and cadences.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING, Any

from litestar import WebSocket, websocket
from litestar.channels import ChannelsPlugin
from msgspec import json as msgspec_json

from geometrikks.domain.realtime.events import LIVE_EVENTS_CHANNEL
from geometrikks.domain.realtime.stream import (
    batched_frames,
    close_service_unavailable,
    passthrough_frames,
    stream_json_frames,
    subscription,
)
from geometrikks.server import runtime
from geometrikks.server.logging import get_logger, log_broadcaster, register_success_level

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
# The pump's local relay queue between the channel subscriber and
# batched_frames. Bursts beyond this drop the oldest queued event first
# (never blocks the channel pump); a separate, counted drop happens later in
# batched_frames when a single flush window has more than MAX_EVENTS_PER_FRAME.
LIVE_QUEUE_MAXSIZE = 1000


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
    """Stream committed ingestion events from the live_events channel, batched
    and coalesced. Fan-out is cross-process (Postgres LISTEN/NOTIFY via
    ChannelsPlugin), not tied to this worker's own ingestion instance, so the
    gate is DB availability rather than "is ingestion running here"."""
    await socket.accept()
    if not getattr(socket.app.state, "db_available", False):
        await close_service_unavailable(
            socket, endpoint="/ws/live", reason="live feed unavailable (database down)"
        )
        return

    channels = socket.app.plugins.get(ChannelsPlugin)

    async def stream() -> AsyncGenerator[Frame]:
        logger.info("ws_client_connected", endpoint="/ws/live")
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=LIVE_QUEUE_MAXSIZE)

        async def pump() -> None:
            # A malformed payload or any other per-event failure must not kill
            # the pump for the rest of the connection: log it and keep going.
            try:
                async for raw in subscriber.iter_events():
                    try:
                        event = msgspec_json.decode(raw)
                        try:
                            queue.put_nowait(event)
                        except asyncio.QueueFull:
                            try:
                                queue.get_nowait()
                                queue.put_nowait(event)
                            except (asyncio.QueueEmpty, asyncio.QueueFull):
                                pass
                    except Exception:
                        logger.exception("ws_live_pump_event_failed", endpoint="/ws/live")
            except asyncio.CancelledError:
                raise
            except Exception:
                # Defensive: iter_events() itself failing would otherwise silently
                # degrade the feed to heartbeat-only with no trace in the logs.
                logger.exception("ws_live_pump_failed", endpoint="/ws/live")

        async with channels.start_subscription(LIVE_EVENTS_CHANNEL) as subscriber:
            pump_task = asyncio.create_task(pump(), name="ws-live-pump")
            try:
                async for frame in batched_frames(
                    queue,
                    flush_interval=FLUSH_INTERVAL,
                    max_items=MAX_EVENTS_PER_FRAME,
                    heartbeat_interval=HEARTBEAT_INTERVAL,
                    make_frame=lambda events, dropped: {
                        "type": "batch", "events": events, "dropped": dropped
                    },
                ):
                    yield frame
            finally:
                pump_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await pump_task
                logger.info("ws_client_disconnected", endpoint="/ws/live")

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
