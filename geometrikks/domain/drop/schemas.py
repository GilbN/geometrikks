"""Wire shapes for the DROP lists endpoint and the About page."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated

import msgspec

from geometrikks.domain.drop.snapshot import DropSnapshot, FeedState

DROP_TERMS_URL = "https://www.spamhaus.org/drop/terms/"
FEED_ORDER = ("v4", "v6", "asn")


class DropNetworkView(msgspec.Struct, rename="camel"):
    """A network on the DROP list."""

    cidr: str
    sbl_id: Annotated[str, msgspec.Meta(description="The Spamhaus SBL record id of the listing, such as `SBL123456`.")]


class DropAsnView(msgspec.Struct, rename="camel"):
    """An autonomous system on the ASN-DROP list."""

    asn: int
    name: Annotated[str | None, msgspec.Meta(description="The AS name the list gives.")]


class DropFeedView(msgspec.Struct, rename="camel"):
    """The download state of one DROP feed."""

    feed: Annotated[
        str, msgspec.Meta(description="`v4` and `v6` for the network lists, `asn` for the ASN-DROP list.")
    ]
    record_count: Annotated[
        int | None, msgspec.Meta(description="The record count the feed states. Null before the first download.")
    ]
    upstream_timestamp: Annotated[
        datetime | None, msgspec.Meta(description="When Spamhaus generated the feed GeoMetrikks holds.")
    ]
    fetched_at: Annotated[datetime | None, msgspec.Meta(description="When a download of the feed last worked.")]
    checked_at: Annotated[
        datetime | None,
        msgspec.Meta(description="When GeoMetrikks last tried to download the feed, whether or not it worked."),
    ]
    last_error: Annotated[
        str | None,
        msgspec.Meta(description="Why the last download failed. Null once a download works."),
    ]


class DropListsResponse(msgspec.Struct, rename="camel"):
    """The Spamhaus DROP lists and the state of each feed."""

    enabled: Annotated[bool, msgspec.Meta(description="False with DROP_ENABLED=false.")]
    loaded: Annotated[bool, msgspec.Meta(description="True once GeoMetrikks has downloaded at least one feed.")]
    updated_at: Annotated[datetime | None, msgspec.Meta(description="When the most recent feed fetch succeeded.")]
    stale: Annotated[bool, msgspec.Meta(description="True when `updatedAt` is more than 7 days ago.")]
    copyright: Annotated[str | None, msgspec.Meta(description="The copyright line Spamhaus ships with the feeds.")]
    networks: Annotated[list[DropNetworkView], msgspec.Meta(description="Sorted by CIDR.")]
    asns: Annotated[list[DropAsnView], msgspec.Meta(description="Sorted by ASN.")]
    feeds: Annotated[
        list[DropFeedView],
        msgspec.Meta(description="In the order `v4`, `v6`, `asn`, and only the feeds GeoMetrikks has tried."),
    ]


class DropListsAboutView(msgspec.Struct, rename="camel"):
    """The state of the Spamhaus DROP lists."""

    enabled: bool
    loaded: Annotated[bool, msgspec.Meta(description="True once GeoMetrikks has downloaded at least one feed.")]
    updated_at: Annotated[datetime | None, msgspec.Meta(description="When the most recent feed fetch succeeded.")]
    stale: Annotated[bool, msgspec.Meta(description="True when `updatedAt` is more than 7 days ago.")]
    copyright: Annotated[str | None, msgspec.Meta(description="The copyright line Spamhaus ships with the feeds.")]
    terms_url: Annotated[str, msgspec.Meta(description="Spamhaus's terms of use for the DROP lists.")]
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
