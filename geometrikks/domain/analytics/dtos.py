"""DTOs for analytics data transfer."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, date

from advanced_alchemy.extensions.litestar import SQLAlchemyDTO, SQLAlchemyDTOConfig
from geometrikks.domain.analytics.models import HourlyStats, DailyStats


class HourlyStatsDTO(SQLAlchemyDTO[HourlyStats]):
    """Data transfer object for HourlyStats model."""

    config = SQLAlchemyDTOConfig(rename_strategy="camel")


class DailyStatsDTO(SQLAlchemyDTO[DailyStats]):
    """Data transfer object for DailyStats model."""

    config = SQLAlchemyDTOConfig(rename_strategy="camel")


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


@dataclass
class TimeSeriesResponse:
    """Response containing time-series data for charts."""

    granularity: str  # "hourly" or "daily"
    start_date: str
    end_date: str
    data: list[TimeSeriesDataPoint] = field(default_factory=list)


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
    """Response containing geo events time-series data."""

    granularity: str
    start_date: str
    end_date: str
    data: list[GeoEventsDataPoint] = field(default_factory=list)


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

    requests: float | None = None
    geo_events: float | None = None
    unique_ips: float | None = None
    bytes_sent: float | None = None
    avg_request_time: float | None = None
    error_rate: float | None = None


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
