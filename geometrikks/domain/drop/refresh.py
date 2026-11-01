"""Refresh the DROP tables from the Spamhaus feeds, one feed at a time."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Literal

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as postgres_insert

from geometrikks.domain.drop.feeds import (
    DropFeed,
    DropFeedError,
    FeedMetadata,
    fetch_feed,
    parse_asn_feed,
    parse_network_feed,
)
from geometrikks.domain.drop.models import DropAsn, DropListState, DropNetwork
from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from collections.abc import Callable

    import httpx2
    from sqlalchemy.ext.asyncio import AsyncSession

logger = get_logger(__name__)

FEEDS: tuple[DropFeed, ...] = ("v4", "v6", "asn")
MIN_CHECK_INTERVAL = timedelta(hours=1)
NETWORK_FAMILY_BY_FEED: dict[str, int] = {"v4": 4, "v6": 6}


@dataclass
class FeedOutcome:
    feed: DropFeed
    status: Literal["imported", "unchanged", "skipped", "failed"]
    records: int | None
    reason: str | None


@dataclass
class FirstRunFlag:
    """Tells the scheduled job whether it is the first run since startup."""

    pending: bool = True

    def consume(self) -> bool:
        was_pending = self.pending
        self.pending = False
        return was_pending


async def refresh_drop_lists(
    session_factory: Callable[[], AsyncSession],
    *,
    now: datetime,
    startup: bool = False,
    refresh_hours: int = 24,
    transport: httpx2.AsyncBaseTransport | None = None,
) -> list[FeedOutcome]:
    """Fetch each feed that is due and replace its rows. One feed failing leaves the others alone."""
    feed_outcomes: list[FeedOutcome] = []
    for feed in FEEDS:
        try:
            feed_outcome = await _refresh_feed(
                session_factory,
                feed,
                now=now,
                startup=startup,
                refresh_hours=refresh_hours,
                transport=transport,
            )
        except Exception as error:
            feed_outcome = await _record_failure(session_factory, feed, error, now=now)
        feed_outcomes.append(feed_outcome)
    return feed_outcomes


async def _refresh_feed(
    session_factory: Callable[[], AsyncSession],
    feed: DropFeed,
    *,
    now: datetime,
    startup: bool,
    refresh_hours: int,
    transport: httpx2.AsyncBaseTransport | None,
) -> FeedOutcome:
    async with session_factory() as session:
        list_state = (
            await session.execute(select(DropListState).where(DropListState.feed == feed))
        ).scalar_one_or_none()

    skip_reason = _skip_reason(list_state, now=now, startup=startup, refresh_hours=refresh_hours)
    if skip_reason is not None:
        logger.info("drop_list_refresh_skipped", feed=feed, reason=skip_reason)
        return FeedOutcome(feed, "skipped", None, skip_reason)

    body = await fetch_feed(feed, transport=transport)
    row_dicts: list[dict[str, object]]
    if feed == "asn":
        asn_records, metadata = parse_asn_feed(body)
        row_dicts = [
            {
                "asn": asn_record.asn,
                "name": asn_record.name,
                "country_code": asn_record.country_code,
                "rir": asn_record.rir,
                "domain": asn_record.domain,
            }
            for asn_record in asn_records
        ]
    else:
        network_records, metadata = parse_network_feed(body, feed)
        row_dicts = [
            {"cidr": network_record.cidr, "sbl_id": network_record.sbl_id, "rir": network_record.rir}
            for network_record in network_records
        ]

    if list_state is not None and list_state.upstream_timestamp == metadata.timestamp:
        async with session_factory() as session, session.begin():
            await session.execute(
                update(DropListState)
                .where(DropListState.feed == feed)
                .values(fetched_at=now, checked_at=now, last_error=None)
            )
        logger.info(
            "drop_lists_refreshed",
            feed=feed,
            records=metadata.records,
            upstream_timestamp=metadata.timestamp.isoformat(),
            changed=False,
        )
        return FeedOutcome(feed, "unchanged", metadata.records, None)

    async with session_factory() as session, session.begin():
        await _replace_rows(session, feed, row_dicts)
        await _upsert_state(session, feed, metadata=metadata, now=now)
    logger.info(
        "drop_lists_refreshed",
        feed=feed,
        records=metadata.records,
        upstream_timestamp=metadata.timestamp.isoformat(),
        changed=True,
    )
    return FeedOutcome(feed, "imported", metadata.records, None)


def _skip_reason(
    list_state: DropListState | None, *, now: datetime, startup: bool, refresh_hours: int
) -> str | None:
    if list_state is None:
        return None
    if list_state.checked_at is not None and list_state.checked_at > now - MIN_CHECK_INTERVAL:
        return "checked less than an hour ago"
    if startup and list_state.fetched_at is not None and list_state.fetched_at > now - timedelta(hours=refresh_hours):
        return "fresh"
    return None


async def _replace_rows(session: AsyncSession, feed: DropFeed, row_dicts: list[dict[str, object]]) -> None:
    if feed == "asn":
        await session.execute(delete(DropAsn))
        await session.execute(insert(DropAsn), row_dicts)
        return
    await session.execute(
        delete(DropNetwork).where(func.family(DropNetwork.cidr) == NETWORK_FAMILY_BY_FEED[feed])
    )
    await session.execute(insert(DropNetwork), row_dicts)


async def _upsert_state(session: AsyncSession, feed: DropFeed, *, metadata: FeedMetadata, now: datetime) -> None:
    state_values = {
        "upstream_timestamp": metadata.timestamp,
        "record_count": metadata.records,
        "copyright": metadata.copyright,
        "fetched_at": now,
        "checked_at": now,
        "last_error": None,
    }
    statement = postgres_insert(DropListState).values(feed=feed, **state_values)
    await session.execute(statement.on_conflict_do_update(index_elements=["feed"], set_=state_values))


async def _record_failure(
    session_factory: Callable[[], AsyncSession], feed: DropFeed, error: Exception, *, now: datetime
) -> FeedOutcome:
    if isinstance(error, DropFeedError):
        reason = str(error)
        logger.warning("drop_list_refresh_failed", feed=feed, reason=reason)
    else:
        reason = f"unexpected error: {type(error).__name__}"
        logger.warning("drop_list_refresh_failed", feed=feed, reason=reason, exc_info=error)
    try:
        async with session_factory() as session, session.begin():
            statement = postgres_insert(DropListState).values(feed=feed, checked_at=now, last_error=reason)
            await session.execute(
                statement.on_conflict_do_update(
                    index_elements=["feed"], set_={"checked_at": now, "last_error": reason}
                )
            )
    except Exception:
        logger.warning("drop_list_state_write_failed", feed=feed, exc_info=True)
    return FeedOutcome(feed, "failed", None, reason)
