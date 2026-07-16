"""DTOs for analytics data transfer."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class TimeSeriesDataPoint:
    """A single data point in a time-series response.

    Used for charting requests, bandwidth, performance over time.
    """

    timestamp: str  # ISO format string for JSON serialization
    total_requests: int
    total_geo_events: int
    total_bytes_sent: int
    status_2xx: int
    status_3xx: int
    status_4xx: int
    status_5xx: int
    error_rate: float
    avg_request_time: float
    p50_request_time: float
    p95_request_time: float
    p99_request_time: float


@dataclass
class PerformanceDataPoint:
    """Performance metrics for a single time point.

    Used for response time charts.
    """

    timestamp: str  # ISO format string
    avg_request_time: float
    max_request_time: float


@dataclass
class BandwidthDataPoint:
    """Bandwidth metrics for a single time point."""

    timestamp: str  # ISO format string
    total_bytes_sent: int
    avg_bytes_per_request: float


@dataclass
class GeoEventsDataPoint:
    """Geo events metrics for a single time point."""

    timestamp: str  # ISO format string
    total_geo_events: int
    unique_ips: int
    unique_countries: int
    unique_cities: int


@dataclass
class TimeSeriesResponse:
    """Response containing time-series data for charts.

    ``data`` is deliberately default-less so it is required in OpenAPI and
    non-optional in the generated TS client.
    """

    granularity: str  # "hourly" or "daily"
    start_date: str
    end_date: str
    data: list[TimeSeriesDataPoint]


@dataclass
class PerformanceTimeSeriesResponse:
    """Response containing performance time-series data."""

    granularity: str
    start_date: str
    end_date: str
    data: list[PerformanceDataPoint] = field(default_factory=list)


@dataclass
class BandwidthTimeSeriesResponse:
    """Response containing bandwidth time-series data."""

    granularity: str
    start_date: str
    end_date: str
    data: list[BandwidthDataPoint] = field(default_factory=list)


@dataclass
class GeoEventsTimeSeriesResponse:
    """Response containing geo events time-series data.

    ``data`` is deliberately default-less (see TimeSeriesResponse).
    """

    granularity: str
    start_date: str
    end_date: str
    data: list[GeoEventsDataPoint]


@dataclass
class PeriodSummary:
    """Summary statistics for a single period."""

    total_requests: int
    total_geo_events: int
    unique_ips: int
    unique_countries: int
    total_bytes_sent: int
    avg_bytes_per_request: float
    status_2xx: int
    status_3xx: int
    status_4xx: int
    status_5xx: int
    avg_request_time: float
    max_request_time: float
    malformed_requests: int
    error_rate: float


@dataclass
class PercentChange:
    """Percent change between two periods."""

    log_records: float | None = None
    geo_records: float | None = None
    unique_ips: float | None = None
    bytes_sent: float | None = None
    avg_request_time: float | None = None
    error_rate: float | None = None
    malformed_rate: float | None = None


@dataclass
class SummaryResponse:
    """Response containing summary statistics with optional comparison.

    Used for dashboard header cards showing key metrics.
    """

    start_date: str
    end_date: str
    current_period: PeriodSummary
    previous_period: PeriodSummary | None = None
    percent_changes: PercentChange | None = None


@dataclass
class StatusDistributionPoint:
    """Status code distribution for a time point."""

    timestamp: str
    status_2xx: int
    status_3xx: int
    status_4xx: int
    status_5xx: int
    total: int


@dataclass
class StatusDistributionResponse:
    """Response containing status code distribution over time."""

    granularity: str
    start_date: str
    end_date: str
    data: list[StatusDistributionPoint] = field(default_factory=list)


@dataclass
class CumulativeDataPoint:
    """Cumulative metrics for a single time point.

    Running totals that reset at the start of the selected time range.
    """

    timestamp: str  # ISO format string
    cumulative_geo_events: int
    cumulative_access_logs: int
    cumulative_bytes: int


@dataclass
class CumulativeTimeSeriesResponse:
    """Response containing cumulative time-series data for area charts."""

    granularity: str  # "hourly" or "daily"
    start_date: str
    end_date: str
    data: list[CumulativeDataPoint] = field(default_factory=list)


@dataclass
class TopUrlDTO:
    """A single URL with its aggregate hit metrics."""

    url: str
    hits: int
    error_hits: int
    total_bytes: int
    avg_request_time: float


@dataclass
class TopUrlsResponse:
    """Response containing top URLs by hit count.

    ``items`` is deliberately default-less: a dataclass default makes it
    non-required in OpenAPI and therefore optional in the generated TS client.
    """

    start_date: str
    end_date: str
    items: list[TopUrlDTO]


@dataclass
class TopUserAgentDTO:
    """A single user agent with its hit count."""

    user_agent: str
    hits: int


@dataclass
class TopUserAgentsResponse:
    """Response containing top user agents by hit count.

    ``items`` is deliberately default-less (see TopUrlsResponse).
    """

    start_date: str
    end_date: str
    items: list[TopUserAgentDTO]


@dataclass
class TopIpDTO:
    """A single IP address with its aggregate hit metrics."""

    ip_address: str
    hits: int
    error_hits: int
    total_bytes: int
    country_code: str | None
    city: str | None


@dataclass
class TopIpsResponse:
    """Response containing top IPs by hit count.

    ``items`` is deliberately default-less (see TopUrlsResponse).
    """

    start_date: str
    end_date: str
    items: list[TopIpDTO] = field(default_factory=list)


@dataclass
class TopCountryStatsDTO:
    """A single country with its aggregate metrics."""

    country_code: str
    country_name: str | None
    hits: int
    unique_ips: int


@dataclass
class TopCountriesStatsResponse:
    """Response containing top countries by hit count.

    ``items`` is deliberately default-less (see TopUrlsResponse).
    """

    start_date: str
    end_date: str
    items: list[TopCountryStatsDTO] = field(default_factory=list)


@dataclass
class TopCityStatsDTO:
    """A single city with its aggregate metrics."""

    city: str
    country_code: str | None
    hits: int
    unique_ips: int


@dataclass
class TopCitiesResponse:
    """Response containing top cities by hit count.

    ``items`` is deliberately default-less (see TopUrlsResponse).
    """

    start_date: str
    end_date: str
    items: list[TopCityStatsDTO] = field(default_factory=list)
