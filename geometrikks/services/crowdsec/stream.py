"""Decision stream poller: keeps the banned-IP set and fans LAPI ban/unban deltas out to live subscribers."""
from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from geometrikks.lib.validation import canonical_ip
from geometrikks.server.logging import get_logger
from geometrikks.services.crowdsec.exceptions import CrowdSecError
from geometrikks.services.crowdsec.schemas import Decision, DecisionStreamDelta
from geometrikks.services.crowdsec.service import CrowdSecService

logger = get_logger(__name__)

DecisionFrame = dict[str, Any]

RESYNC_SECONDS = 600.0


@dataclass(frozen=True, slots=True)
class HeldDecision:
    """The decision the stream last sent for one IP and type.

    ``duration`` is the time left as the LAPI sent it at ``seen_at``.
    """

    origin: str
    duration: str
    seen_at: datetime


def _held(decision: Decision, seen_at: datetime) -> HeldDecision:
    return HeldDecision(origin=decision.origin, duration=decision.duration, seen_at=seen_at)


def _ip_of(decision: Decision) -> str | None:
    # Same canonical spelling as /banned-ips, so a delta patches the
    # cached entry instead of adding a second one for an IPv6 alias.
    return canonical_ip(decision.value) if decision.scope == "Ip" else None


def _added_entry(ip: str, decision: Decision) -> DecisionFrame:
    return {
        "ip": ip, "type": decision.type, "origin": decision.origin,
        "scenario": decision.scenario, "duration": decision.duration,
    }


class CrowdSecStreamPoller:
    """Polls ``GET /v1/decisions/stream``, keeps the IP decision set, and broadcasts deltas.

    The first poll passes ``startup=true`` and gets the full current decision
    state, potentially a whole CAPI blocklist. It seeds the set and is not
    broadcast: subscribers load the same state from ``/banned-ips``. Later
    polls return only what changed.

    The LAPI tracks the stream position per bouncer key, so another bouncer
    polling with the same key takes deltas this poller never sees. Every
    ``resync_seconds`` a poll asks for the full state again, replaces the set,
    and broadcasts the difference.
    """

    def __init__(self, service: CrowdSecService, *, resync_seconds: float = RESYNC_SECONDS) -> None:
        self._service = service
        self._resync_seconds = resync_seconds
        self._lock = asyncio.Lock()
        self._synced_at: float | None = None
        # IP -> decision type -> the decision held. With the stream's default
        # dedup the LAPI sends the longest decision per IP and type, and
        # reports it deleted only when no decision of that type is left on the
        # IP. A deleted longest one leaves a shorter one whose expiry is not
        # sent, so the held duration can run long until the next resync.
        self._ip_decisions: dict[str, dict[str, HeldDecision]] = {}
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

    def ip_decisions(self) -> Mapping[str, Mapping[str, HeldDecision]] | None:
        """Each IP under an Ip-scoped decision, by decision type.

        None until the first poll succeeds and while the last poll failed,
        when the set may have fallen behind the LAPI.
        """
        if self._synced_at is None or self._lapi_reachable is not True:
            return None
        return self._ip_decisions

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
            self._last_success = datetime.now(UTC)
        if changed:
            self._broadcast({"type": "crowdsec_status", "lapi_reachable": reachable})

    async def poll(self) -> None:
        """One stream poll; scheduler-driven, and run after a ban or unban.

        Never raises: the LAPI being down must not kill the job, the next
        interval simply retries.
        """
        # Two overlapping polls would read the same stream position, and the
        # older answer could land last and undo the newer one.
        async with self._lock:
            await self._poll()

    async def _poll(self) -> None:
        full = self._synced_at is None or time.monotonic() - self._synced_at >= self._resync_seconds
        try:
            delta: DecisionStreamDelta = await self._service.get_decisions_stream(startup=full)
        except CrowdSecError as exc:
            logger.warning("CrowdSec stream poll failed: %s", exc)
            self._set_reachable(False)
            return
        if self._lapi_reachable is False:
            logger.success("crowdsec_stream_connected")  # ty: ignore[unresolved-attribute]
        # Update the set before any frame goes out, since a subscriber
        # refetches /banned-ips when a frame arrives.
        frame = self._replace(delta.new) if full else self._apply(delta)
        self._set_reachable(True)
        if frame is None or (not frame["added"] and not frame["deleted"]):
            return
        logger.info(
            "CrowdSec decision stream: %d added, %d expired/removed",
            len(frame["added"]), len(frame["deleted"]),
        )
        self._broadcast(frame)

    def _apply(self, delta: DecisionStreamDelta) -> DecisionFrame:
        """Patch the set with one delta, deletions first, as subscribers do."""
        deleted = []
        for decision in delta.deleted:
            if (ip := _ip_of(decision)) is None:
                continue
            deleted.append({"ip": ip, "type": decision.type, "origin": decision.origin})
            held = self._ip_decisions.get(ip)
            if held is not None:
                held.pop(decision.type, None)
                if not held:
                    del self._ip_decisions[ip]
        added = []
        now = datetime.now(UTC)
        for decision in delta.new:
            if (ip := _ip_of(decision)) is None:
                continue
            added.append(_added_entry(ip, decision))
            self._ip_decisions.setdefault(ip, {})[decision.type] = _held(decision, now)
        return {"type": "crowdsec_decisions", "added": added, "deleted": deleted}

    def _replace(self, decisions: list[Decision]) -> DecisionFrame | None:
        """Rebuild the set from the full state. Returns the difference as a frame, or None on the first load."""
        fresh: dict[str, dict[str, HeldDecision]] = {}
        added = []
        now = datetime.now(UTC)
        for decision in decisions:
            if (ip := _ip_of(decision)) is None:
                continue
            held = fresh.setdefault(ip, {})
            if decision.type in held:
                continue
            held[decision.type] = _held(decision, now)
            if decision.type not in self._ip_decisions.get(ip, {}):
                added.append(_added_entry(ip, decision))
        first_load = self._synced_at is None
        deleted = [
            {"ip": ip, "type": kind, "origin": held_decision.origin}
            for ip, held in self._ip_decisions.items()
            for kind, held_decision in held.items()
            if kind not in fresh.get(ip, {})
        ]
        self._ip_decisions = fresh
        self._synced_at = time.monotonic()
        if first_load:
            logger.info("crowdsec_decisions_loaded", ips=len(fresh))
            return None
        logger.debug("crowdsec_decisions_resynced", ips=len(fresh), added=len(added), deleted=len(deleted))
        return {"type": "crowdsec_decisions", "added": added, "deleted": deleted}
