"""Response schemas for the analytics endpoints.

msgspec Structs with camelCase renaming (see geo/schemas.py for the idiom).
Python attributes stay snake_case; the digit-adjacent status fields pin their
wire names explicitly because the camel strategy would render status_2xx as
"status2Xx".
"""

from __future__ import annotations

from typing import Annotated, Literal

import msgspec

from geometrikks.domain.analytics.asn_classification import ASN_CATEGORY_DESCRIPTION, AsnCategory

BucketStart = Annotated[str, msgspec.Meta(description="The bucket start, as ISO 8601 in UTC.")]
EchoedStart = Annotated[str, msgspec.Meta(description="The request's `startDate`, echoed as ISO 8601.")]
EchoedEnd = Annotated[str, msgspec.Meta(description="The request's `endDate`, echoed as ISO 8601.")]
ErrorRate = Annotated[
    float, msgspec.Meta(description="The share of requests with a 4xx or 5xx status, from 0 to 1.")
]
OLD_AGGREGATE_TIMING_NOTE = (
    "Aggregated buckets older than the raw retention window may predate that rule. Those still count "
    "upgrades and status 0 lines, and the oldest count every request, timed or not."
)
TimedRequests = Annotated[
    int,
    msgspec.Meta(
        description=(
            "Requests with a measured request time, leaving out WebSocket upgrades and status 0 lines. "
            f"{OLD_AGGREGATE_TIMING_NOTE}"
        )
    ),
]
ErrorHits = Annotated[int, msgspec.Meta(description="Hits with a status of 400 or higher.")]


class TimeSeriesDataPoint(msgspec.Struct, rename="camel"):
    """Request metrics for one bucket.

    Request times are in seconds and cover the requests `timedRequests` counts. Each one is null when the
    bucket has none. Without a filter, the percentiles are estimates.
    """

    timestamp: BucketStart
    total_requests: int
    total_geo_events: Annotated[
        int, msgspec.Meta(description="Always 0. `/api/v1/analytics/geo-time-series` has the geo series.")
    ]
    total_bytes_sent: int
    status_2xx: int = msgspec.field(name="status2xx")
    status_3xx: int = msgspec.field(name="status3xx")
    status_4xx: int = msgspec.field(name="status4xx")
    status_5xx: int = msgspec.field(name="status5xx")
    error_rate: ErrorRate
    timed_requests: TimedRequests
    avg_request_time: float | None
    max_request_time: float | None
    p50_request_time: float | None
    p95_request_time: float | None
    p99_request_time: float | None


class PerformanceDataPoint(msgspec.Struct, rename="camel"):
    """Performance metrics for a single time point.

    Used for response time charts.
    """

    timestamp: str  # ISO format string
    timed_requests: int
    avg_request_time: float | None
    max_request_time: float | None


class BandwidthDataPoint(msgspec.Struct, rename="camel"):
    """Bandwidth metrics for a single time point."""

    timestamp: str  # ISO format string
    total_bytes_sent: int
    avg_bytes_per_request: float


class GeoEventsDataPoint(msgspec.Struct, rename="camel"):
    """Geo event counts for one bucket. The unique counts are estimates."""

    timestamp: BucketStart
    total_geo_events: int
    unique_ips: int
    unique_countries: int
    unique_cities: int


ChartGranularityField = Annotated[str, msgspec.Meta(description="The bucket size used, `hourly` or `daily`.")]


# The response lists have no defaults on purpose. A default makes the field
# optional in OpenAPI and in the generated TS client.
class TimeSeriesResponse(msgspec.Struct, rename="camel"):
    """Request metrics per bucket, oldest first. Buckets without requests are left out."""

    granularity: ChartGranularityField
    start_date: EchoedStart
    end_date: EchoedEnd
    data: list[TimeSeriesDataPoint]


class PerformanceTimeSeriesResponse(msgspec.Struct, rename="camel"):
    """Response containing performance time-series data."""

    granularity: str
    start_date: str
    end_date: str
    data: list[PerformanceDataPoint] = msgspec.field(default_factory=list)


class BandwidthTimeSeriesResponse(msgspec.Struct, rename="camel"):
    """Response containing bandwidth time-series data."""

    granularity: str
    start_date: str
    end_date: str
    data: list[BandwidthDataPoint] = msgspec.field(default_factory=list)


class GeoEventsTimeSeriesResponse(msgspec.Struct, rename="camel"):
    """Geo event counts per bucket, oldest first. Buckets without events are left out."""

    granularity: ChartGranularityField
    start_date: EchoedStart
    end_date: EchoedEnd
    data: list[GeoEventsDataPoint]


class PeriodSummary(msgspec.Struct, rename="camel"):
    """Request and geo event totals for one period.

    Request times are in seconds over the requests `timedRequests` counts, and null when it is 0.
    """

    total_requests: int
    timed_requests: TimedRequests
    total_geo_events: Annotated[
        int, msgspec.Meta(description="Logged requests whose client IP has a GeoIP location.")
    ]
    unique_ips: Annotated[int, msgspec.Meta(description="Distinct client IPs among the geo events.")]
    unique_countries: Annotated[int, msgspec.Meta(description="Distinct countries among the geo events.")]
    total_bytes_sent: int
    avg_bytes_per_request: float
    status_2xx: int = msgspec.field(name="status2xx")
    status_3xx: int = msgspec.field(name="status3xx")
    status_4xx: int = msgspec.field(name="status4xx")
    status_5xx: int = msgspec.field(name="status5xx")
    avg_request_time: float | None
    max_request_time: float | None
    malformed_requests: Annotated[
        int,
        msgspec.Meta(
            description=(
                "Lines GeoMetrikks flagged as malformed, counted by when it stored them rather than by "
                "their log time."
            )
        ),
    ]
    error_rate: ErrorRate


class PercentChange(msgspec.Struct, rename="camel"):
    """The percent change of each figure from the previous period.

    25.0 means a rise of a quarter. A figure is null when its previous value is 0 or was not measured.
    """

    log_records: Annotated[float | None, msgspec.Meta(description="The change in `totalRequests`.")] = None
    geo_records: Annotated[float | None, msgspec.Meta(description="The change in `totalGeoEvents`.")] = None
    unique_ips: float | None = None
    bytes_sent: float | None = None
    avg_request_time: float | None = None
    error_rate: Annotated[
        float | None,
        msgspec.Meta(description="The relative change of `errorRate` itself, not a difference in percentage points."),
    ] = None
    malformed_rate: Annotated[
        float | None,
        msgspec.Meta(
            description="The change in `malformedRequests`. Always null on `/api/v1/analytics/live-summary`."
        ),
    ] = None


class SummaryResponse(msgspec.Struct, rename="camel"):
    """Totals for a time range, and optionally for the period of the same length before it."""

    start_date: EchoedStart
    end_date: EchoedEnd
    current_period: PeriodSummary
    previous_period: Annotated[
        PeriodSummary | None,
        msgspec.Meta(
            description=(
                "Null unless `comparePrevious` is true and the range and the previous period each have requests "
                "or geo events."
            )
        ),
    ] = None
    percent_changes: Annotated[
        PercentChange | None,
        msgspec.Meta(description="Null whenever `previousPeriod` is null."),
    ] = None


class StatusDistributionPoint(msgspec.Struct, rename="camel"):
    """Status code distribution for a time point."""

    timestamp: str
    status_2xx: int = msgspec.field(name="status2xx")
    status_3xx: int = msgspec.field(name="status3xx")
    status_4xx: int = msgspec.field(name="status4xx")
    status_5xx: int = msgspec.field(name="status5xx")
    total: int


class StatusDistributionResponse(msgspec.Struct, rename="camel"):
    """Response containing status code distribution over time."""

    granularity: str
    start_date: str
    end_date: str
    data: list[StatusDistributionPoint] = msgspec.field(default_factory=list)


class CumulativeDataPoint(msgspec.Struct, rename="camel"):
    """Running totals through the end of one bucket.

    Ranges up to 24 hours count from `startDate`. Longer ranges count from the start of the hour or UTC
    day that holds it.
    """

    timestamp: BucketStart
    cumulative_geo_events: int
    cumulative_access_logs: int
    cumulative_bytes: int


class CumulativeTimeSeriesResponse(msgspec.Struct, rename="camel"):
    """Running totals of requests, geo events and bytes, one point per bucket, oldest first."""

    granularity: Annotated[
        str,
        msgspec.Meta(
            description=(
                "`raw` for ranges up to 24 hours, which have hourly buckets counted from the raw rows. "
                "Otherwise `hourly` or `daily`."
            )
        ),
    ]
    start_date: EchoedStart
    end_date: EchoedEnd
    data: list[CumulativeDataPoint] = msgspec.field(default_factory=list)


class TopUrlDTO(msgspec.Struct, rename="camel"):
    """One host and path with its hits."""

    host: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "The Host header of the requests. Null when the log line carries none, as in nginx's combined format."
            )
        ),
    ]
    url: Annotated[str, msgspec.Meta(description="The request target, query string included.")]
    hits: int
    error_hits: ErrorHits
    total_bytes: int
    timed_hits: Annotated[
        int,
        msgspec.Meta(
            description=(
                "Hits with a measured request time, leaving out WebSocket upgrades and status 0 lines. "
                "Aggregated buckets older than the raw retention window may predate that rule. Those still "
                "count upgrades and status 0 lines, and the oldest count every hit, timed or not."
            )
        ),
    ]
    avg_request_time: Annotated[
        float | None,
        msgspec.Meta(description="The mean request time in seconds over the `timedHits`. Null when it is 0."),
    ]


class TopUrlsResponse(msgspec.Struct, rename="camel"):
    """Host and path pairs ordered by hits, most first."""

    start_date: EchoedStart
    end_date: EchoedEnd
    items: list[TopUrlDTO]


class TopUserAgentDTO(msgspec.Struct, rename="camel"):
    """One user agent string with its hits."""

    user_agent: str
    hits: int


class TopUserAgentsResponse(msgspec.Struct, rename="camel"):
    """User agents ordered by hits, most first."""

    start_date: EchoedStart
    end_date: EchoedEnd
    items: list[TopUserAgentDTO]


AsnOrganization = Annotated[
    str | None,
    msgspec.Meta(description="The network's name from the GeoLite2 ASN database. Null when it has none."),
]


class TopAsnDTO(msgspec.Struct, rename="camel"):
    """One autonomous system with its hits and bytes."""

    asn: int
    organization: AsnOrganization
    hits: int
    total_bytes: int
    category: Annotated[AsnCategory, msgspec.Meta(description=ASN_CATEGORY_DESCRIPTION)]


class AsnCategoryTotalsDTO(msgspec.Struct, rename="camel"):
    """Hits and bytes summed over every ASN of one category."""

    category: Annotated[AsnCategory, msgspec.Meta(description=ASN_CATEGORY_DESCRIPTION)]
    hits: int
    total_bytes: int


class TopAsnsResponse(msgspec.Struct, rename="camel"):
    """Autonomous systems ordered by hits, with totals per category.

    Requests without ASN data appear in `totalRequests` and `totalBytes` but in no category, so the
    difference is the traffic GeoMetrikks could not match to an ASN.
    """

    start_date: EchoedStart
    end_date: EchoedEnd
    total_requests: Annotated[int, msgspec.Meta(description="Every request in the range, with or without ASN data.")]
    total_bytes: Annotated[
        int, msgspec.Meta(description="The bytes of every request in the range, with or without ASN data.")
    ]
    items: list[TopAsnDTO]
    categories: Annotated[
        list[AsnCategoryTotalsDTO],
        msgspec.Meta(
            description=(
                "Totals over every ASN in the range, not only the listed ones. `drop` appears once the "
                "ASN-DROP list has downloaded."
            )
        ),
    ]
    drop_asn_count: Annotated[
        int | None,
        msgspec.Meta(
            description=(
                "How many ASN-DROP listed ASNs sent traffic in the range, counting those beyond `limit`. "
                "Null until the ASN-DROP list has downloaded."
            )
        ),
    ]


class TopIpDTO(msgspec.Struct, rename="camel"):
    """One client IP with its hits."""

    ip_address: str
    hits: int
    error_hits: ErrorHits
    total_bytes: int
    country_code: Annotated[str | None, msgspec.Meta(description="Null when GeoIP has no country for the IP.")]
    city: Annotated[str | None, msgspec.Meta(description="Null when GeoIP has no city for the IP.")]
    asn: Annotated[
        int | None,
        msgspec.Meta(description="The autonomous system the IP belongs to. Null when the IP has no ASN data."),
    ]
    as_organization: AsnOrganization


class TopIpsResponse(msgspec.Struct, rename="camel"):
    """Client IPs ordered by hits, most first."""

    start_date: EchoedStart
    end_date: EchoedEnd
    items: list[TopIpDTO]


class TopCountryStatsDTO(msgspec.Struct, rename="camel"):
    """One country with its hits."""

    country_code: str
    country_name: str | None
    hits: int
    unique_ips: Annotated[int, msgspec.Meta(description="Distinct client IPs from the country.")]


class TopCountriesStatsResponse(msgspec.Struct, rename="camel"):
    """Countries ordered by hits, most first."""

    start_date: EchoedStart
    end_date: EchoedEnd
    items: list[TopCountryStatsDTO]


CityCountryCode = Annotated[
    str | None,
    msgspec.Meta(
        description=(
            "A country with a city of this name in the range. Cities with the same name in different "
            "countries share one row."
        )
    ),
]


class TopCityStatsDTO(msgspec.Struct, rename="camel"):
    """One city with its hits."""

    city: str
    country_code: CityCountryCode
    hits: int
    unique_ips: Annotated[int, msgspec.Meta(description="Distinct client IPs from the city.")]


class TopCitiesResponse(msgspec.Struct, rename="camel"):
    """Cities ordered by hits, most first."""

    start_date: EchoedStart
    end_date: EchoedEnd
    items: list[TopCityStatsDTO]


class IpProfileBucketDTO(msgspec.Struct, rename="camel"):
    """One bucket of an IP's hit series."""

    timestamp: BucketStart
    hits: int
    error_hits: ErrorHits


RequestHost = Annotated[str | None, msgspec.Meta(description="The Host header. Null for lines that carry none.")]


class IpProfileHostDTO(msgspec.Struct, rename="camel"):
    """One host this IP sent requests to, with its hits."""

    host: RequestHost
    hits: int
    error_hits: ErrorHits


class IpProfilePathDTO(msgspec.Struct, rename="camel"):
    """One host and path this IP requested, with its hits."""

    host: RequestHost
    url: Annotated[str, msgspec.Meta(description="The request target, query string included.")]
    hits: int
    error_hits: ErrorHits


class IpProfileUserAgentDTO(msgspec.Struct, rename="camel"):
    """One user agent this IP sent, with its hits."""

    user_agent: str
    hits: int


# A zeroed profile instead of a 404 lets the IP inspector sheet still show
# the ban state and the other locations.
class IpProfileResponse(msgspec.Struct, rename="camel"):
    """The access log profile of one client IP for a time range.

    An IP without requests in the range gets zero request counts and empty lists rather than a 404.
    Request times are in seconds over the timed requests.
    """

    ip_address: str
    start_date: EchoedStart
    end_date: EchoedEnd
    total_requests: int
    status_2xx: int = msgspec.field(name="status2xx")
    status_3xx: int = msgspec.field(name="status3xx")
    status_4xx: int = msgspec.field(name="status4xx")
    status_5xx: int = msgspec.field(name="status5xx")
    error_rate: ErrorRate
    total_bytes: int
    timed_requests: TimedRequests
    avg_request_time: float | None
    p95_request_time: float | None
    first_seen: Annotated[
        str | None,
        msgspec.Meta(description="The IP's first request in the range, as ISO 8601 in UTC."),
    ]
    last_seen: Annotated[
        str | None,
        msgspec.Meta(description="The IP's last request in the range, as ISO 8601 in UTC."),
    ]
    distinct_paths: Annotated[int, msgspec.Meta(description="How many different request targets the IP sent.")]
    malformed_requests: Annotated[
        int,
        msgspec.Meta(
            description=(
                "Lines from the IP that GeoMetrikks flagged as malformed, counted by when it stored them rather "
                "than by their log time."
            )
        ),
    ]
    asn: Annotated[
        int | None,
        msgspec.Meta(description="The ASN of the IP's newest request in the range that had one."),
    ]
    asn_organization: AsnOrganization
    asn_category: Annotated[
        AsnCategory | None, msgspec.Meta(description=f"{ASN_CATEGORY_DESCRIPTION} Null without ASN data.")
    ]
    granularity: Annotated[
        Literal["hourly", "daily"],
        msgspec.Meta(description="`hourly` for ranges up to 7 days, `daily` above."),
    ]
    series: Annotated[
        list[IpProfileBucketDTO],
        msgspec.Meta(description="Hits per bucket, oldest first. Buckets without hits are left out."),
    ]
    peak: Annotated[
        IpProfileBucketDTO | None,
        msgspec.Meta(description="The bucket with the most hits, the earliest one on a tie."),
    ]
    hosts: Annotated[list[IpProfileHostDTO], msgspec.Meta(description="Up to 5 hosts, most hits first.")]
    paths: Annotated[
        list[IpProfilePathDTO], msgspec.Meta(description="Up to 5 host and path pairs, most hits first.")
    ]
    user_agents: Annotated[
        list[IpProfileUserAgentDTO], msgspec.Meta(description="Up to 3 user agents, most hits first.")
    ]
