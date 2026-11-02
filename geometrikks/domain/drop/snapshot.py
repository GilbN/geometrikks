"""In-memory view of the DROP tables, shared by every request in the process."""
from __future__ import annotations

import asyncio
import contextlib
import time
from bisect import bisect_right
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from ipaddress import IPv4Address, IPv6Address, ip_address, ip_network
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from geometrikks.domain.drop.models import DropAsn, DropListState, DropNetwork
from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from collections.abc import Callable

    from sqlalchemy.ext.asyncio import AsyncSession

logger = get_logger(__name__)

STATE_CHECK_INTERVAL_SECONDS = 60.0
STALE_AFTER = timedelta(days=7)
NETWORK_FEEDS = ("v4", "v6")


@dataclass(frozen=True)
class DropNetworkMatch:
    cidr: str
    sbl_id: str


@dataclass(frozen=True)
class DropAsnEntry:
    asn: int
    name: str | None
    country_code: str | None


@dataclass(frozen=True)
class FeedState:
    feed: str
    upstream_timestamp: datetime | None
    record_count: int | None
    copyright: str | None
    fetched_at: datetime | None
    checked_at: datetime | None
    last_error: str | None


class _RangeIndex:
    """Address ranges of one IP version, searched with bisect.

    Ranges are sorted by (start, prefix length), so the rightmost range that
    starts at or before an address is the most specific candidate. DROP
    networks do not overlap in practice; the running maximum of the range ends
    keeps the backwards walk short and still finds the enclosing network if
    two ever do.
    """

    def __init__(self, ranges: list[tuple[int, int, int, DropNetworkMatch]]) -> None:
        ordered_ranges = sorted(ranges, key=lambda drop_range: (drop_range[0], drop_range[2]))
        self._starts = [(drop_range[0], drop_range[2]) for drop_range in ordered_ranges]
        self._ends = [drop_range[1] for drop_range in ordered_ranges]
        self._matches = [drop_range[3] for drop_range in ordered_ranges]
        self._running_max_end: list[int] = []
        highest_end = -1
        for end in self._ends:
            highest_end = max(highest_end, end)
            self._running_max_end.append(highest_end)

    def find(self, address_int: int) -> DropNetworkMatch | None:
        index = bisect_right(self._starts, (address_int, 129)) - 1
        while index >= 0 and self._running_max_end[index] >= address_int:
            if self._ends[index] >= address_int:
                return self._matches[index]
            index -= 1
        return None


def _unwrap_mapped(address: IPv4Address | IPv6Address) -> IPv4Address | IPv6Address:
    if isinstance(address, IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


class DropSnapshot:
    """Immutable DROP data: listed networks, listed ASNs and the feed states."""

    def __init__(
        self,
        *,
        networks: tuple[DropNetworkMatch, ...] = (),
        asns: tuple[DropAsnEntry, ...] = (),
        feeds: tuple[FeedState, ...] = (),
    ) -> None:
        self.networks = networks
        self.asns = asns
        self.feeds = feeds
        ranges_by_version: dict[int, list[tuple[int, int, int, DropNetworkMatch]]] = {4: [], 6: []}
        for network_match in networks:
            network = ip_network(network_match.cidr, strict=False)
            ranges_by_version[network.version].append(
                (
                    int(network.network_address),
                    int(network.broadcast_address),
                    network.prefixlen,
                    network_match,
                )
            )
        self._indexes = {version: _RangeIndex(ranges) for version, ranges in ranges_by_version.items()}
        self._asn_entries = {asn_entry.asn: asn_entry for asn_entry in asns}
        fetched_times = [feed.fetched_at for feed in feeds if feed.fetched_at is not None]
        self.updated_at: datetime | None = max(fetched_times) if fetched_times else None
        self.asns_loaded = any(feed.feed == "asn" and feed.fetched_at is not None for feed in feeds)
        self.networks_loaded = any(
            feed.feed in NETWORK_FEEDS and feed.fetched_at is not None for feed in feeds
        )

    @property
    def loaded(self) -> bool:
        """True once at least one feed has been fetched successfully."""
        return self.updated_at is not None

    @property
    def stale(self) -> bool:
        return self.updated_at is not None and datetime.now(UTC) - self.updated_at > STALE_AFTER

    def network_for(self, ip: str | IPv4Address | IPv6Address) -> DropNetworkMatch | None:
        """Most specific listed network containing the address, if any."""
        try:
            address = ip_address(ip) if isinstance(ip, str) else ip
        except ValueError:
            return None
        address = _unwrap_mapped(address)
        return self._indexes[address.version].find(int(address))

    def asn_entry(self, asn: int) -> DropAsnEntry | None:
        return self._asn_entries.get(asn)

    def is_drop_asn(self, asn: int) -> bool:
        return asn in self._asn_entries


EMPTY_DROP_SNAPSHOT = DropSnapshot()

_snapshot: DropSnapshot = EMPTY_DROP_SNAPSHOT
_loaded_state: tuple[tuple[str, datetime | None, datetime | None, str | None], ...] | None = None
_last_state_check: float | None = None
_reload_lock = asyncio.Lock()
_clock: Callable[[], float] = time.monotonic


def current_drop_snapshot() -> DropSnapshot:
    """The snapshot loaded by the last ensure_drop_snapshot call in this process."""
    return _snapshot


def reset_drop_snapshot() -> None:
    """Forget the loaded data so the next ensure_drop_snapshot call queries again."""
    global _snapshot, _loaded_state, _last_state_check, _reload_lock  # noqa: PLW0603
    _snapshot = EMPTY_DROP_SNAPSHOT
    _loaded_state = None
    _last_state_check = None
    _reload_lock = asyncio.Lock()


async def ensure_drop_snapshot(session: AsyncSession, *, enabled: bool) -> DropSnapshot:
    """Refresh the process snapshot when another process changed the tables.

    A refresh job in one worker reaches the others through the feed
    state: each process compares it at most once per minute and reloads on a
    change of fetch time, check time or last error. The error is part of the
    key because a download attempt commits its check time before the request,
    so a failure recorded later carries the same check time. The comparison is
    per feed because a refresh commits the feeds one at a time under one
    timestamp, so a reload between two commits must not hide the later one. With the feature disabled the snapshot is empty
    whatever the tables hold. Once a snapshot has loaded, a failed check keeps
    serving it until the next check is due.
    """
    global _snapshot, _loaded_state, _last_state_check  # noqa: PLW0603
    if not enabled:
        return EMPTY_DROP_SNAPSHOT
    if _state_check_is_fresh():
        return _snapshot
    async with _reload_lock:
        if _state_check_is_fresh():
            return _snapshot
        try:
            state_rows = (
                await session.execute(
                    select(
                        DropListState.feed,
                        DropListState.fetched_at,
                        DropListState.checked_at,
                        DropListState.last_error,
                    ).order_by(DropListState.feed)
                )
            ).all()
            state = tuple((row.feed, row.fetched_at, row.checked_at, row.last_error) for row in state_rows)
            if state != _loaded_state:
                _snapshot = await _load_snapshot(session)
                _loaded_state = state
        except (SQLAlchemyError, OSError):
            if _loaded_state is None:
                raise
            logger.warning("drop_snapshot_reload_failed", exc_info=True)
            with contextlib.suppress(SQLAlchemyError, OSError):
                await session.rollback()
        _last_state_check = _clock()
    return _snapshot


def _state_check_is_fresh() -> bool:
    return _last_state_check is not None and _clock() - _last_state_check < STATE_CHECK_INTERVAL_SECONDS


async def _load_snapshot(session: AsyncSession) -> DropSnapshot:
    network_rows = (
        await session.execute(select(DropNetwork.cidr, DropNetwork.sbl_id).order_by(DropNetwork.cidr))
    ).all()
    asn_rows = (
        await session.execute(
            select(DropAsn.asn, DropAsn.name, DropAsn.country_code).order_by(DropAsn.asn)
        )
    ).all()
    feed_rows = (await session.execute(select(DropListState).order_by(DropListState.feed))).scalars().all()
    return DropSnapshot(
        networks=tuple(DropNetworkMatch(cidr=str(row.cidr), sbl_id=row.sbl_id) for row in network_rows),
        asns=tuple(
            DropAsnEntry(asn=row.asn, name=row.name, country_code=row.country_code) for row in asn_rows
        ),
        feeds=tuple(
            FeedState(
                feed=feed_row.feed,
                upstream_timestamp=feed_row.upstream_timestamp,
                record_count=feed_row.record_count,
                copyright=feed_row.copyright,
                fetched_at=feed_row.fetched_at,
                checked_at=feed_row.checked_at,
                last_error=feed_row.last_error,
            )
            for feed_row in feed_rows
        ),
    )
