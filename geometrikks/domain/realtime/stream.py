"""Shared machinery for the /ws feeds.

The three live feeds share one shape: subscribe to a process-local broker,
stream JSON frames until the client goes away, heartbeat when idle, and
always unsubscribe. This module owns that machinery once:

- :func:`subscription` - subscribe/unsubscribe lifecycle with connect and
  disconnect audit logs.
- :func:`batched_frames` / :func:`passthrough_frames` - the two delivery
  policies (drain-and-flush with drop accounting vs one frame per item).
- :func:`stream_json_frames` - the transport wrapper over Litestar's
  ``send_websocket_stream``, which supplies the send loop and disconnect
  detection.
- :func:`close_service_unavailable` - the degraded-mode 1013 closure.

Feed-specific concerns (event conversion, level filters, snapshot frames,
cadences, frame caps) stay in the handlers in ``controllers.py``.

Transport decisions (0.7.0): Litestar's ``send_websocket_stream`` function is
the adopted wrapper; the ``@websocket_stream`` decorator was not, because the
feeds must accept and then close 1013 in degraded mode before any streaming
starts. ``ChannelsPlugin`` was evaluated and deliberately not adopted: these
are fixed, process-local feeds with no dynamic topics, history, or
cross-process fan-out, and an in-memory Channels backend would not lift the
single-worker constraint. Revisit only if those requirements appear.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any, Protocol

from litestar.exceptions import WebSocketDisconnect
from litestar.handlers import send_websocket_stream

from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator, Callable, Iterable

    from litestar import WebSocket

logger = get_logger(__name__)

Frame = dict[str, Any]


class Subscribable(Protocol):
    """The broker shape all three feeds share (ingestion service,
    CrowdSec stream poller, log broadcaster)."""

    def subscribe(self) -> asyncio.Queue: ...

    def unsubscribe(self, queue: asyncio.Queue) -> None: ...


async def close_service_unavailable(socket: WebSocket, *, endpoint: str, reason: str) -> None:
    """Close 1013 (try again later): the feed's backing service is not running.

    Clients treat 1013 as a signal to fall back to periodic refetch instead
    of reconnect-looping against a degraded server.
    """
    logger.warning("ws_rejected_service_unavailable", endpoint=endpoint)
    await socket.close(code=1013, reason=reason)


@asynccontextmanager
async def subscription(
    broker: Subscribable, *, endpoint: str
) -> AsyncGenerator[asyncio.Queue]:
    """Subscribe to a broker for the lifetime of the block; always unsubscribe.

    The ``finally`` runs on client disconnect, server-side cancellation
    (shutdown), and send errors alike, so dead connections can never leave
    their queue subscribed.
    """
    queue = broker.subscribe()
    logger.info("ws_client_connected", endpoint=endpoint)
    try:
        yield queue
    finally:
        broker.unsubscribe(queue)
        logger.info("ws_client_disconnected", endpoint=endpoint)


async def batched_frames(
    queue: asyncio.Queue,
    *,
    flush_interval: float,
    max_items: int,
    heartbeat_interval: float,
    make_frame: Callable[[list[Any], int], Frame],
    expand: Callable[[Any], Iterable[Any]] | None = None,
) -> AsyncGenerator[Frame]:
    """Drain the queue in flush windows and yield batch frames.

    Items beyond ``max_items`` per frame are counted, not silently lost:
    ``make_frame(items, dropped)`` receives the overflow count so the client
    gets a rate signal instead of melting. ``expand`` maps one queue item to
    zero or more frame items (event conversion, level filtering). When idle,
    an empty frame is yielded every ``heartbeat_interval`` seconds so reverse
    proxies don't cut the socket.
    """
    loop = asyncio.get_running_loop()
    last_send = loop.time()
    pending: list[Any] = []
    dropped = 0
    while True:
        # Drain until the flush deadline.
        deadline = loop.time() + flush_interval
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            try:
                item = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            for entry in expand(item) if expand is not None else (item,):
                if len(pending) >= max_items:
                    dropped += 1
                else:
                    pending.append(entry)

        if pending or dropped or loop.time() - last_send >= heartbeat_interval:
            yield make_frame(pending, dropped)
            pending, dropped = [], 0
            last_send = loop.time()


async def passthrough_frames(
    queue: asyncio.Queue,
    *,
    heartbeat_interval: float,
    make_heartbeat: Callable[[], Frame],
    poll_interval: float = 0.5,
) -> AsyncGenerator[Frame]:
    """Yield each queued frame as-is; heartbeat when idle.

    For low-volume feeds whose broker already produces wire frames
    (the CrowdSec decision stream), so batching would only add latency.
    """
    loop = asyncio.get_running_loop()
    last_send = loop.time()
    while True:
        try:
            frame = await asyncio.wait_for(queue.get(), timeout=poll_interval)
        except asyncio.TimeoutError:
            if loop.time() - last_send >= heartbeat_interval:
                yield make_heartbeat()
                last_send = loop.time()
            continue
        yield frame
        last_send = loop.time()


async def _send_json(socket: WebSocket, frame: Frame) -> None:
    await socket.send_json(frame)


async def stream_json_frames(socket: WebSocket, stream: AsyncGenerator[Frame]) -> None:
    """Send every frame from ``stream`` as a JSON text message until the
    client disconnects.

    ``send_websocket_stream`` supplies the send loop and the background
    disconnect listener; on disconnect it cancels the generator, whose
    ``finally`` blocks (subscription cleanup) still run.

    ``warn_on_data_discard=False`` is the documented inbound-frame policy:
    these feeds are send-only and unexpected client frames are consumed and
    ignored (covered by tests), not warned about.
    """
    try:
        await send_websocket_stream(
            socket,
            stream,
            send_handler=_send_json,
            listen_for_disconnect=True,
            warn_on_data_discard=False,
        )
    except WebSocketDisconnect:
        pass  # client went away between the disconnect check and the send
