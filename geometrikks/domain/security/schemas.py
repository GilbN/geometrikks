"""Shapes for security-domain enrichment results."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal

import msgspec

from geometrikks.domain.geo.dtos import GeoJSONPointGeometry


@dataclass
class IpEnrichment:
    """GeoMetrikks' own knowledge about one IP, joined onto ban decisions."""

    country_code: str | None
    country_name: str | None
    city: str | None
    request_count_24h: int


class IpLocation(msgspec.Struct, rename="camel"):
    """One IP's observed location and its event total in the filtered window."""

    ip: str
    location_id: int
    latitude: float
    longitude: float
    city: str | None
    country_code: str | None
    event_count: int


StrongestDecisionType = Annotated[
    str,
    msgspec.Meta(
        description=(
            "The strongest decision type on it. `ban` beats `captcha`, and other names a bouncer defines come "
            "after both, in alphabetical order."
        )
    ),
]


class BannedIp(msgspec.Struct, rename="camel"):
    """An IP under an active decision."""

    ip: str
    type: StrongestDecisionType


class BannedMapIp(msgspec.Struct, rename="camel", kw_only=True):
    """An IP under an active decision, at one place on the map."""

    ip: str
    location_id: Annotated[int, msgspec.Meta(description="The location's `id`, as `/api/v1/geo-locations` lists it.")]
    city: str | None
    country_code: str | None
    event_count: Annotated[int, msgspec.Meta(description="The IP's geo events in the window, at every location.")]


class BannedMapProperties(msgspec.Struct, rename="camel", kw_only=True):
    """The IPs at one point."""

    group_id: Annotated[str, msgspec.Meta(description="The point's coordinates as `longitude,latitude`.")]
    ip_count: int
    banned_ips: Annotated[list[BannedMapIp], msgspec.Meta(description="The most events first.")]


class BannedMapFeature(msgspec.Struct, rename="camel", kw_only=True):
    """A GeoJSON feature for the IPs that share one point."""

    type: Literal["Feature"]
    id: Annotated[str, msgspec.Meta(description="The same as `properties.groupId`.")]
    geometry: GeoJSONPointGeometry
    properties: BannedMapProperties


class BannedMapStats(msgspec.Struct, rename="camel"):
    """Totals over the IPs on the map."""

    ips: int
    locations: Annotated[int, msgspec.Meta(description="The number of points, which is the number of features.")]
    events: Annotated[int, msgspec.Meta(description="The geo events of every IP on the map, added up.")]
    countries: int
    cities: int


class BannedMapCollection(msgspec.Struct, rename="camel", kw_only=True):
    """A GeoJSON FeatureCollection of the IPs under an active decision.

    IPs at the same coordinates share one feature, and the features are sorted by longitude, then latitude.
    """

    type: Literal["FeatureCollection"]
    features: list[BannedMapFeature]
    stats: BannedMapStats


@dataclass(frozen=True)
class DropNetworkHits:
    """Traffic one DROP network sent in a window."""

    cidr: str
    sbl_id: str
    hits: int
    ips: int
    last_seen: datetime | None


@dataclass(frozen=True)
class DropNetworkOrigin:
    """Where a DROP network's traffic came from, read off its raw access_logs rows."""

    asn: int | None
    as_org: str | None
    last_seen: datetime


class BannedRangeView(msgspec.Struct, rename="camel"):
    """A range under an active decision.

    GeoMetrikks bans a single-address DROP network with an `Ip` decision, and that network shows as its /32 or /128.
    """

    value: Annotated[str, msgspec.Meta(description="The range as a CIDR, such as `203.0.113.0/24`.")]
    type: StrongestDecisionType
    expires_at: Annotated[
        datetime | None,
        msgspec.Meta(
            description=(
                "When the decision with that type ends, the later one when two have the same type. Null when "
                "the LAPI's time left does not parse."
            )
        ),
    ]


SblId = Annotated[str, msgspec.Meta(description="The Spamhaus SBL record id of the listing, such as `SBL123456`.")]


class DropNetworkTrafficView(msgspec.Struct, rename="camel"):
    """One DROP network with the traffic it sent in the window."""

    cidr: str
    sbl_id: SblId
    asn: Annotated[
        int | None,
        msgspec.Meta(
            description=(
                "The ASN most of the network's requests came from. Null when the raw lines have aged out or "
                "carry no ASN."
            )
        ),
    ]
    as_org: Annotated[str | None, msgspec.Meta(description="The name the logs give most often for that ASN.")]
    hits: Annotated[int, msgspec.Meta(description="Requests from the network in the window.")]
    ips: Annotated[int, msgspec.Meta(description="Distinct client IPs in the network that sent them.")]
    last_seen: Annotated[
        datetime | None,
        msgspec.Meta(
            description=(
                "The newest request from the network. Once its raw lines have aged out, the start of the newest "
                "hour or UTC day with traffic."
            )
        ),
    ]
    decision: Annotated[
        BannedRangeView | None,
        msgspec.Meta(
            description="The active decision on the network. Null when it has none or the LAPI did not answer."
        ),
    ]


class DropNetworksResponse(msgspec.Struct, rename="camel"):
    """One page of DROP networks with traffic, with totals over every network."""

    loaded: Annotated[
        bool,
        msgspec.Meta(
            description=(
                "False until GeoMetrikks downloads a DROP network list, and always with DROP_ENABLED=false. Every "
                "count is 0 and `items` is empty then."
            )
        ),
    ]
    days: Annotated[int, msgspec.Meta(description="The window in days, as requested.")]
    total_networks: Annotated[int, msgspec.Meta(description="DROP networks with traffic in the window.")]
    total_ips: Annotated[int, msgspec.Meta(description="Distinct client IPs in those networks.")]
    total_hits: Annotated[int, msgspec.Meta(description="Requests from those networks.")]
    banned_networks: Annotated[
        int,
        msgspec.Meta(description="Networks with traffic that hold an active decision. 0 when the LAPI did not answer."),
    ]
    decisions_available: Annotated[
        bool,
        msgspec.Meta(description="False when the LAPI did not answer. Every `decision` is null then."),
    ]
    items: Annotated[list[DropNetworkTrafficView], msgspec.Meta(description="The most requests first.")]


MAX_BULK_BAN_NETWORKS = 1000


class BanNetworksRequest(msgspec.Struct, rename="camel"):
    """The DROP networks to ban, by name or as every unbanned network with traffic.

    Set exactly one of `networks` and `allUnbannedDays`, or the request gets a 400.
    """

    duration: Annotated[
        str, msgspec.Meta(description="How long each ban lasts, such as `4h`, `30m`, `7d` or `1d12h`.")
    ]
    networks: (
        Annotated[
            list[str],
            msgspec.Meta(
                max_length=MAX_BULK_BAN_NETWORKS,
                description=(
                    f"The networks to ban, as CIDRs from the DROP list, at most {MAX_BULK_BAN_NETWORKS}. A network "
                    "named twice gets one result."
                ),
            ),
        ]
        | None
    ) = None
    all_unbanned_days: Annotated[
        Literal[7, 30, 90] | None,
        msgspec.Meta(
            description=(
                "Ban every DROP network that sent traffic in this many days and has no active decision of any "
                "type, `7`, `30` or `90`."
            )
        ),
    ] = None


class BanNetworkResult(msgspec.Struct, rename="camel"):
    """What happened to one network."""

    network: Annotated[str, msgspec.Meta(description="The network as a CIDR, or as sent when it does not parse.")]
    ok: Annotated[bool, msgspec.Meta(description="True when the network is banned now.")]
    error: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "Why the network is not banned, such as `Not on the DROP list` or the LAPI's error. It starts "
                "with `not attempted` when the run stopped before this network."
            )
        ),
    ]
    already_banned: Annotated[
        bool,
        msgspec.Meta(
            description=(
                "True when the network already had an active decision of any type, a captcha included, and "
                "GeoMetrikks left it alone."
            )
        ),
    ]


class BanNetworksResponse(msgspec.Struct, rename="camel"):
    """The outcome for each network."""

    results: list[BanNetworkResult]
    left_out: Annotated[
        int,
        msgspec.Meta(
            description=(
                f"With `allUnbannedDays`, the networks without a decision past the first {MAX_BULK_BAN_NETWORKS}, "
                "which this run did not try. 0 otherwise."
            )
        ),
    ]
