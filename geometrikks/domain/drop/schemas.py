"""Wire shapes for the DROP lists endpoint and the About page."""
from __future__ import annotations

from datetime import datetime

import msgspec

from geometrikks.domain.drop.snapshot import DropSnapshot, FeedState

DROP_TERMS_URL = "https://www.spamhaus.org/drop/terms/"
FEED_ORDER = ("v4", "v6", "asn")


class DropNetworkView(msgspec.Struct, rename="camel"):
    cidr: str
    sbl_id: str


class DropAsnView(msgspec.Struct, rename="camel"):
    asn: int
    name: str | None


class DropFeedView(msgspec.Struct, rename="camel"):
    feed: str
    record_count: int | None
    upstream_timestamp: datetime | None
    fetched_at: datetime | None
    checked_at: datetime | None
    last_error: str | None


class DropListsResponse(msgspec.Struct, rename="camel"):
    enabled: bool
    loaded: bool
    updated_at: datetime | None
    stale: bool
    copyright: str | None
    networks: list[DropNetworkView]
    asns: list[DropAsnView]
    feeds: list[DropFeedView]


class DropListsAboutView(msgspec.Struct, rename="camel"):
    enabled: bool
    loaded: bool
    updated_at: datetime | None
    stale: bool
    copyright: str | None
    terms_url: str
    feeds: list[DropFeedView]


def _feed_sort_key(feed_state: FeedState) -> tuple[int, str]:
    position = FEED_ORDER.index(feed_state.feed) if feed_state.feed in FEED_ORDER else len(FEED_ORDER)
    return position, feed_state.feed


def drop_feed_views(drop_snapshot: DropSnapshot) -> list[DropFeedView]:
    return [
        DropFeedView(
            feed=feed_state.feed,
            record_count=feed_state.record_count,
            upstream_timestamp=feed_state.upstream_timestamp,
            fetched_at=feed_state.fetched_at,
            checked_at=feed_state.checked_at,
            last_error=feed_state.last_error,
        )
        for feed_state in sorted(drop_snapshot.feeds, key=_feed_sort_key)
    ]


def drop_copyright(drop_snapshot: DropSnapshot) -> str | None:
    """The v4 feed's copyright line, else the first one any feed carries."""
    ordered_states = sorted(drop_snapshot.feeds, key=_feed_sort_key)
    for feed_state in ordered_states:
        if feed_state.copyright:
            return feed_state.copyright
    return None


def build_drop_lists_response(drop_snapshot: DropSnapshot, *, enabled: bool) -> DropListsResponse:
    return DropListsResponse(
        enabled=enabled,
        loaded=drop_snapshot.loaded,
        updated_at=drop_snapshot.updated_at,
        stale=drop_snapshot.stale,
        copyright=drop_copyright(drop_snapshot),
        networks=[
            DropNetworkView(cidr=network_match.cidr, sbl_id=network_match.sbl_id)
            for network_match in drop_snapshot.networks
        ],
        asns=[DropAsnView(asn=asn_entry.asn, name=asn_entry.name) for asn_entry in drop_snapshot.asns],
        feeds=drop_feed_views(drop_snapshot),
    )


def build_drop_lists_about(drop_snapshot: DropSnapshot, *, enabled: bool) -> DropListsAboutView | None:
    if not enabled:
        return None
    return DropListsAboutView(
        enabled=True,
        loaded=drop_snapshot.loaded,
        updated_at=drop_snapshot.updated_at,
        stale=drop_snapshot.stale,
        copyright=drop_copyright(drop_snapshot),
        terms_url=DROP_TERMS_URL,
        feeds=drop_feed_views(drop_snapshot),
    )
