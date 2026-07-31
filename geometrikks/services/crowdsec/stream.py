"""Decision stream poller: fans LAPI ban/unban deltas out to live subscribers."""
from __future__ import annotations
from geometrikks.services.crowdsec.schemas import DecisionStreamDelta

import asyncio
from datetime import datetime, timezone
from typing import Any

from geometrikks.server.logging import get_logger
from geometrikks.services.crowdsec.exceptions import CrowdSecError
from geometrikks.services.crowdsec.service import CrowdSecService

logger = get_logger(__name__)

DecisionFrame = dict[str, Any]


class CrowdSecStreamPoller:
    """Polls ``GET /v1/decisions/stream`` and broadcasts deltas.

    The first poll passes ``startup=true`` and is deliberately not broadcast:
    it returns the full current decision state (potentially a whole CAPI
    blocklist), which subscribers already have via ``/banned-ips``. Only
    subsequent deltas are news.
    """

    def __init__(self, service: CrowdSecService) -> None:
        self._service = service
        self._started = False
        self._lapi_reachable: bool | None = None
        self._last_success: datetime | None = None
        self._subscribers: set[asyncio.Queue[DecisionFrame]] = set()

    def subscribe(self, maxsize: int = 100) -> asyncio.Queue[DecisionFrame]:
        """Register a live subscriber. Caller must unsubscribe()."""
        queue: asyncio.Queue[DecisionFrame] = asyncio.Queue(maxsize=maxsize)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[DecisionFrame]) -> None:
        self._subscribers.discard(queue)

    @property
    def lapi_reachable(self) -> bool | None:
        """Cached LAPI verdict from the last poll; None until the first poll.

        The single source of truth for reachability: /crowdsec/status and
        /health read this instead of probing the LAPI themselves.
        """
        return self._lapi_reachable

    @property
    def last_success(self) -> datetime | None:
        return self._last_success

    def _broadcast(self, frame: DecisionFrame) -> None:
        for queue in self._subscribers:
            try:
                queue.put_nowait(frame)
            except asyncio.QueueFull:
                # A stalled browser must not backpressure the poller; it will
                # resync from /banned-ips on its next refetch.
                logger.debug("Dropping frame for slow subscriber")

    def _set_reachable(self, reachable: bool) -> None:
        """Record a poll outcome; broadcast a status frame on any transition.

        None -> X counts: a page that connected before the first poll must
        still learn the state.
        """
        changed = self._lapi_reachable != reachable
        self._lapi_reachable = reachable
        if reachable:
            self._last_success = datetime.now(timezone.utc)
        if changed:
            self._broadcast({"type": "crowdsec_status", "lapi_reachable": reachable})

    async def poll(self) -> None:
        """One stream poll; scheduler-driven. Never raises: the LAPI being

        down must not kill the job, the next interval simply retries.
        """
        try:
            delta: DecisionStreamDelta = await self._service.get_decisions_stream(startup=not self._started)
        except CrowdSecError as exc:
            logger.warning("CrowdSec stream poll failed: %s", exc)
            self._set_reachable(False)
            return
        if self._lapi_reachable is False:
            logger.success("crowdsec_stream_connected")  # ty: ignore[unresolved-attribute]
        self._set_reachable(True)
        first_poll = not self._started
        self._started = True
        if first_poll:
            return

        added = [
            {"ip": d.value, "origin": d.origin, "scenario": d.scenario, "duration": d.duration}
            for d in delta.new
            if d.scope == "Ip"
        ]
        deleted = [
            {"ip": d.value, "origin": d.origin} for d in delta.deleted if d.scope == "Ip"
        ]
        if not added and not deleted:
            return

        logger.info(
            "CrowdSec decision stream: %d added, %d expired/removed", len(added), len(deleted)
        )
        self._broadcast({"type": "crowdsec_decisions", "added": added, "deleted": deleted})
