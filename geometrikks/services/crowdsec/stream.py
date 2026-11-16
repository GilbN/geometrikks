"""Decision stream poller: keeps the active decisions and fans LAPI ban/unban deltas out to live subscribers."""
from __future__ import annotations

import asyncio
import time
from collections.abc import Collection, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from geometrikks.lib.validation import canonical_ip
from geometrikks.server.logging import get_logger
from geometrikks.services.crowdsec.exceptions import CrowdSecError
from geometrikks.services.crowdsec.schemas import (
    Decision,
    DecisionStreamDelta,
    go_duration,
    go_duration_seconds,
)
from geometrikks.services.crowdsec.service import CrowdSecService

logger = get_logger(__name__)

DecisionFrame = dict[str, Any]
IpKey = tuple[str, str]

RESYNC_SECONDS = 600.0


@dataclass(frozen=True, slots=True)
class _Held:
    decision: Decision
    # None when the duration did not parse; the stream still reports the end.
    expires_at: datetime | None


def _expiry(held: _Held) -> datetime:
    return held.expires_at or datetime.max.replace(tzinfo=UTC)


def _ip_of(decision: Decision) -> str | None:
    # Same canonical spelling as /banned-ips, so a delta patches the
    # cached entry instead of adding a second one for an IPv6 alias.
    return canonical_ip(decision.value) if decision.scope == "Ip" else None


def _added_entry(ip: str, decision: Decision) -> DecisionFrame:
    return {
        "ip": ip, "type": decision.type, "origin": decision.origin,
        "scenario": decision.scenario, "duration": decision.duration,
    }


def _frame(before: Mapping[IpKey, Decision], after: Mapping[IpKey, Decision]) -> DecisionFrame:
    """The IP and type pairs that gained their first decision or lost their last one."""
    return {
        "type": "crowdsec_decisions",
        "added": [_added_entry(key[0], decision) for key, decision in after.items() if key not in before],
        "deleted": [
            {"ip": key[0], "type": key[1], "origin": decision.origin}
            for key, decision in before.items()
            if key not in after
        ],
    }


class CrowdSecStreamPoller:
    """Polls ``GET /v1/decisions/stream``, keeps every active decision, and broadcasts deltas.

    The first poll passes ``startup=true`` and gets the full current decision
    state, potentially a whole CAPI blocklist. It seeds the decisions and is
    not broadcast: subscribers load the same state from ``/banned-ips``.
    Later polls return only what changed.

    The LAPI tracks the stream position per bouncer key, so another bouncer
    polling with the same key takes deltas this poller never sees. Every
    ``resync_seconds`` a poll asks for the full state again, replaces the
    decisions, and broadcasts the difference.
    """

    def __init__(self, service: CrowdSecService, *, resync_seconds: float = RESYNC_SECONDS) -> None:
        self._service = service
        self._resync_seconds = resync_seconds
        self._lock = asyncio.Lock()
        self._synced_at: float | None = None
        self._decisions: dict[int, _Held] = {}
        # IP -> decision type -> ids of the Ip-scoped decisions held.
        self._ip_types: dict[str, dict[str, set[int]]] = {}
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

    def _current(self) -> bool:
        """False until the first poll succeeds and while the last poll failed,
        when the decisions may have fallen behind the LAPI."""
        return self._synced_at is not None and self._lapi_reachable is True

    def ip_decision_types(self) -> Mapping[str, Collection[str]] | None:
        """The decision types on each IP under an Ip-scoped decision, or None when not current."""
        return self._ip_types if self._current() else None

    def decisions(
        self, *, scopes: Collection[str] | None = None, origins: Collection[str] | None = None
    ) -> list[Decision] | None:
        """Every active decision, with the time left as of now, or None when not current.

        ``scopes`` and ``origins`` keep the decisions whose scope or origin
        they name, spelled as the LAPI sends them (``Ip``, ``CAPI``).
        """
        if not self._current():
            return None
        now = datetime.now(UTC)
        active: list[Decision] = []
        for held in self._decisions.values():
            decision = held.decision
            if (scopes is not None and decision.scope not in scopes) or (
                origins is not None and decision.origin not in origins
            ):
                continue
            if held.expires_at is None:
                active.append(decision)
                continue
            seconds_left = round((held.expires_at - now).total_seconds())
            if seconds_left <= 0:
                continue
            # Field by field because dataclasses.replace takes twice as long
            # over a CAPI blocklist, so a new Decision field must be added here.
            active.append(Decision(
                id=decision.id, origin=decision.origin, type=decision.type, scope=decision.scope,
                value=decision.value, duration=go_duration(seconds_left), scenario=decision.scenario,
                simulated=decision.simulated,
            ))
        return active

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
        # Update the decisions before any frame goes out, since a subscriber
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

    def _hold(self, decision: Decision, now: datetime) -> None:
        if decision.id is None:
            return
        self._drop(decision.id)
        seconds_left = go_duration_seconds(decision.duration)
        expires_at = now + timedelta(seconds=seconds_left) if seconds_left > 0 else None
        self._decisions[decision.id] = _Held(decision, expires_at)
        if (ip := _ip_of(decision)) is not None:
            self._ip_types.setdefault(ip, {}).setdefault(decision.type, set()).add(decision.id)

    def _drop(self, decision_id: int) -> None:
        held = self._decisions.pop(decision_id, None)
        if held is None or (ip := _ip_of(held.decision)) is None:
            return
        types = self._ip_types[ip]
        ids = types[held.decision.type]
        ids.discard(decision_id)
        if not ids:
            del types[held.decision.type]
        if not types:
            del self._ip_types[ip]

    def _longest(self, keys: Iterable[IpKey]) -> dict[IpKey, Decision]:
        """The longest-lived decision held on each IP and type that has one."""
        longest: dict[IpKey, Decision] = {}
        for ip, kind in keys:
            ids = self._ip_types.get(ip, {}).get(kind)
            if ids:
                longest[ip, kind] = max((self._decisions[i] for i in ids), key=_expiry).decision
        return longest

    def _ip_keys(self) -> list[IpKey]:
        return [(ip, kind) for ip, types in self._ip_types.items() for kind in types]

    def _apply(self, delta: DecisionStreamDelta) -> DecisionFrame:
        """Patch the decisions with one delta, deletions first."""
        keys = list(dict.fromkeys(
            (ip, decision.type)
            for decision in (*delta.deleted, *delta.new)
            if (ip := _ip_of(decision)) is not None
        ))
        before = self._longest(keys)
        for decision in delta.deleted:
            if decision.id is not None:
                self._drop(decision.id)
        now = datetime.now(UTC)
        for decision in delta.new:
            self._hold(decision, now)
        return _frame(before, self._longest(keys))

    def _replace(self, decisions: list[Decision]) -> DecisionFrame | None:
        """Rebuild the decisions from the full state. Returns the difference as a frame, or None on the first load."""
        before = self._longest(self._ip_keys())
        self._decisions = {}
        self._ip_types = {}
        now = datetime.now(UTC)
        for decision in decisions:
            self._hold(decision, now)
        first_load = self._synced_at is None
        self._synced_at = time.monotonic()
        if first_load:
            logger.info("crowdsec_decisions_loaded", decisions=len(self._decisions), ips=len(self._ip_types))
            return None
        frame = _frame(before, self._longest(self._ip_keys()))
        logger.debug(
            "crowdsec_decisions_resynced", decisions=len(self._decisions), ips=len(self._ip_types),
            added=len(frame["added"]), deleted=len(frame["deleted"]),
        )
        return frame
