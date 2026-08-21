"""Response schemas for the analytics endpoints.

msgspec Structs with camelCase renaming (see geo/schemas.py for the idiom).
Python attributes stay snake_case; the digit-adjacent status fields pin their
wire names explicitly because the camel strategy would render status_2xx as
"status2Xx".
"""

from __future__ import annotations

import msgspec

from geometrikks.domain.analytics.asn_classification import AsnCategory


class TimeSeriesDataPoint(msgspec.Struct, rename="camel"):
    """A single data point in a time-series response.

    Used for charting requests, bandwidth, performance over time.
    """

    timestamp: str  # ISO format string for JSON serialization
    total_requests: int
    total_geo_events: int
    total_bytes_sent: int
    status_2xx: int = msgspec.field(name="status2xx")
    status_3xx: int = msgspec.field(name="status3xx")
    status_4xx: int = msgspec.field(name="status4xx")
    status_5xx: int = msgspec.field(name="status5xx")
    error_rate: float
    avg_request_time: float
    p50_request_time: float
    p95_request_time: float
    p99_request_time: float


class PerformanceDataPoint(msgspec.Struct, rename="camel"):
    """Performance metrics for a single time point.

    Used for response time charts.
    """

    timestamp: str  # ISO format string
    avg_request_time: float
    max_request_time: float


class BandwidthDataPoint(msgspec.Struct, rename="camel"):
    """Bandwidth metrics for a single time point."""

    timestamp: str  # ISO format string
    total_bytes_sent: int
    avg_bytes_per_request: float


class GeoEventsDataPoint(msgspec.Struct, rename="camel"):
    """Geo events metrics for a single time point."""

    timestamp: str  # ISO format string
    total_geo_events: int
    unique_ips: int
    unique_countries: int
    unique_cities: int


class TimeSeriesResponse(msgspec.Struct, rename="camel"):
    """Response containing time-series data for charts.

    ``data`` is deliberately default-less so it is required in OpenAPI and
    non-optional in the generated TS client.
    """

    granularity: str  # "hourly" or "daily"
    start_date: str
    end_date: str
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
    """Response containing geo events time-series data.

    ``data`` is deliberately default-less (see TimeSeriesResponse).
    """

    granularity: str
    start_date: str
    end_date: str
    data: list[GeoEventsDataPoint]


class PeriodSummary(msgspec.Struct, rename="camel"):
    """Summary statistics for a single period."""

    total_requests: int
    total_geo_events: int
    unique_ips: int
    unique_countries: int
    total_bytes_sent: int
    avg_bytes_per_request: float
    status_2xx: int = msgspec.field(name="status2xx")
    status_3xx: int = msgspec.field(name="status3xx")
    status_4xx: int = msgspec.field(name="status4xx")
    status_5xx: int = msgspec.field(name="status5xx")
    avg_request_time: float
    max_request_time: float
    malformed_requests: int
    error_rate: float


class PercentChange(msgspec.Struct, rename="camel"):
    """Percent change between two periods."""

    log_records: float | None = None
    geo_records: float | None = None
    unique_ips: float | None = None
    bytes_sent: float | None = None
    avg_request_time: float | None = None
    error_rate: float | None = None
    malformed_rate: float | None = None


class SummaryResponse(msgspec.Struct, rename="camel"):
    """Response containing summary statistics with optional comparison.

    Used for dashboard header cards showing key metrics.
    """

    start_date: str
    end_date: str
    current_period: PeriodSummary
    previous_period: PeriodSummary | None = None
    percent_changes: PercentChange | None = None


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
    """Cumulative metrics for a single time point.

    Running totals that reset at the start of the selected time range.
    """

    timestamp: str  # ISO format string
    cumulative_geo_events: int
    cumulative_access_logs: int
    cumulative_bytes: int


class CumulativeTimeSeriesResponse(msgspec.Struct, rename="camel"):
    """Response containing cumulative time-series data for area charts."""

    granularity: str  # "hourly" or "daily"
    start_date: str
    end_date: str
    data: list[CumulativeDataPoint] = msgspec.field(default_factory=list)


class TopUrlDTO(msgspec.Struct, rename="camel"):
    """A single URL with its aggregate hit metrics."""

    url: str
    hits: int
    error_hits: int
    total_bytes: int
    avg_request_time: float


class TopUrlsResponse(msgspec.Struct, rename="camel"):
    """Response containing top URLs by hit count.

    ``items`` is deliberately default-less: a dataclass default makes it
    non-required in OpenAPI and therefore optional in the generated TS client.
    """

    start_date: str
    end_date: str
    items: list[TopUrlDTO]


class TopUserAgentDTO(msgspec.Struct, rename="camel"):
    """A single user agent with its hit count."""

    user_agent: str
    hits: int


class TopUserAgentsResponse(msgspec.Struct, rename="camel"):
    """Response containing top user agents by hit count.

    ``items`` is deliberately default-less (see TopUrlsResponse).
    """

    start_date: str
    end_date: str
    items: list[TopUserAgentDTO]


class TopAsnDTO(msgspec.Struct, rename="camel"):
    """A single autonomous system with its aggregate metrics."""

    asn: int
    organization: str | None
    hits: int
    total_bytes: int
    category: AsnCategory


class AsnCategoryTotalsDTO(msgspec.Struct, rename="camel"):
    """Aggregate hits/bytes for one traffic-origin category."""

    category: AsnCategory
    hits: int
    total_bytes: int


class TopAsnsResponse(msgspec.Struct, rename="camel"):
    """Response containing top ASNs plus exact category totals.

    ``categories`` is computed over ALL ASNs in the range (not just the top
    N items), so the datacenter share is exact. ``total_requests`` and
    ``total_bytes`` count every request in the range, ASN-tagged or not:
    NULL-ASN rows (pre-feature history, disabled or failed enrichment) are
    invisible to the categories, so shares must be judged against these
    totals, never against the category sum. Lists are deliberately
    default-less (see TopUrlsResponse).
    """

    start_date: str
    end_date: str
    total_requests: int
    total_bytes: int
    items: list[TopAsnDTO]
    categories: list[AsnCategoryTotalsDTO]


class TopIpDTO(msgspec.Struct, rename="camel"):
    """A single IP address with its aggregate hit metrics."""

    ip_address: str
    hits: int
    error_hits: int
    total_bytes: int
    country_code: str | None
    city: str | None


class TopIpsResponse(msgspec.Struct, rename="camel"):
    """Response containing top IPs by hit count.

    ``items`` is deliberately default-less (see TopUrlsResponse).
    """

    start_date: str
    end_date: str
    items: list[TopIpDTO]


class TopCountryStatsDTO(msgspec.Struct, rename="camel"):
    """A single country with its aggregate metrics."""

    country_code: str
    country_name: str | None
    hits: int
    unique_ips: int


class TopCountriesStatsResponse(msgspec.Struct, rename="camel"):
    """Response containing top countries by hit count.

    ``items`` is deliberately default-less (see TopUrlsResponse).
    """

    start_date: str
    end_date: str
    items: list[TopCountryStatsDTO]


class TopCityStatsDTO(msgspec.Struct, rename="camel"):
    """A single city with its aggregate metrics."""

    city: str
    country_code: str | None
    hits: int
    unique_ips: int


class TopCitiesResponse(msgspec.Struct, rename="camel"):
    """Response containing top cities by hit count.

    ``items`` is deliberately default-less (see TopUrlsResponse).
    """

    start_date: str
    end_date: str
    items: list[TopCityStatsDTO]
