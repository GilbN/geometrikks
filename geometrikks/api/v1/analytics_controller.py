"""Analytics API endpoints for dashboard data."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Literal, Sequence

from litestar import Controller, get
from litestar.di import Provide
from litestar.params import Parameter
from litestar.openapi.spec import Example

from geometrikks.domain.analytics.repositories import (
    HourlyStatsRepository,
    DailyStatsRepository,
    Granularity,
    SummaryStats,
    DailyStats,
    HourlyStats
)
from geometrikks.domain.analytics.dtos import (
    TimeSeriesResponse,
    TimeSeriesDataPoint,
    PerformanceTimeSeriesResponse,
    PerformanceDataPoint,
    BandwidthTimeSeriesResponse,
    BandwidthDataPoint,
    GeoEventsTimeSeriesResponse,
    GeoEventsDataPoint,
    SummaryResponse,
    PeriodSummary,
    PercentChange,
)

from geometrikks.api.dependencies import (
    provide_hourly_stats_repo,
    provide_daily_stats_repo,
)


def _calculate_percent_change(current: float, previous: float) -> float | None:
    """Calculate percent change between two values."""
    if previous == 0:
        return None
    return ((current - previous) / previous) * 100


class AnalyticsController(Controller):
    """Analytics endpoints for dashboard data and time-series charts."""

    path = "/api/v1/analytics"
    tags = ["Analytics"]

    dependencies = {
        "hourly_stats_repo": Provide(provide_hourly_stats_repo),
        "daily_stats_repo": Provide(provide_daily_stats_repo),
    }

    @get("/summary", description="Get summary statistics for dashboard header cards.")
    async def get_summary(
        self,
        hourly_stats_repo: HourlyStatsRepository,
        daily_stats_repo: DailyStatsRepository,
        start_date: Annotated[
            datetime,
            Parameter(
                description="Start date (ISO 8601, e.g., 2024-01-01T00:00:00Z)",
                examples=[Example(value="2024-01-01T00:00:00Z")],
            ),
        ],
        end_date: Annotated[
            datetime,
            Parameter(
                description="End date (ISO 8601, e.g., 2024-12-31T23:59:59Z)",
                examples=[Example(value="2024-12-31T23:59:59Z")],
            ),
        ],
        compare_previous: Annotated[
            bool,
            Parameter(
                description="Include comparison with previous period of same length",
                default=False,
            ),
        ] = False,
    ) -> SummaryResponse:
        """Get aggregated summary statistics for a date range.

        Ideal for populating dashboard header cards with key metrics.
        Optionally includes comparison with the previous period.
        """

        # Get current period stats
        current_stats: SummaryStats | None = await hourly_stats_repo.get_summary(start_date, end_date)

        if current_stats is None:
            # Return empty summary if no data
            empty_period = PeriodSummary(
                total_requests=0,
                total_geo_events=0,
                unique_ips=0,
                unique_countries=0,
                total_bytes_sent=0,
                avg_bytes_per_request=0.0,
                status_2xx=0,
                status_3xx=0,
                status_4xx=0,
                status_5xx=0,
                avg_request_time=0.0,
                max_request_time=0.0,
                malformed_requests=0,
                error_rate=0.0,
            )
            return SummaryResponse(
                start_date=start_date.isoformat(),
                end_date=end_date.isoformat(),
                current_period=empty_period,
            )

        current_period = PeriodSummary(
            total_requests=current_stats.total_requests,
            total_geo_events=current_stats.total_geo_events,
            unique_ips=current_stats.unique_ips,
            unique_countries=current_stats.unique_countries,
            total_bytes_sent=current_stats.total_bytes_sent,
            avg_bytes_per_request=current_stats.avg_bytes_per_request,
            status_2xx=current_stats.status_2xx,
            status_3xx=current_stats.status_3xx,
            status_4xx=current_stats.status_4xx,
            status_5xx=current_stats.status_5xx,
            avg_request_time=current_stats.avg_request_time,
            max_request_time=current_stats.max_request_time,
            malformed_requests=current_stats.malformed_requests,
            error_rate=current_stats.error_rate,
        )

        previous_period = None
        percent_changes = None

        if compare_previous:
            # Calculate previous period of same length (works for any timedelta)
            period_length: timedelta = end_date - start_date
            prev_end: datetime = start_date - timedelta(seconds=1)
            prev_start: datetime = prev_end - period_length

            prev_stats: SummaryStats | None = await hourly_stats_repo.get_summary(prev_start, prev_end)

            if prev_stats:
                previous_period = PeriodSummary(
                    total_requests=prev_stats.total_requests,
                    total_geo_events=prev_stats.total_geo_events,
                    unique_ips=prev_stats.unique_ips,
                    unique_countries=prev_stats.unique_countries,
                    total_bytes_sent=prev_stats.total_bytes_sent,
                    avg_bytes_per_request=prev_stats.avg_bytes_per_request,
                    status_2xx=prev_stats.status_2xx,
                    status_3xx=prev_stats.status_3xx,
                    status_4xx=prev_stats.status_4xx,
                    status_5xx=prev_stats.status_5xx,
                    avg_request_time=prev_stats.avg_request_time,
                    max_request_time=prev_stats.max_request_time,
                    malformed_requests=prev_stats.malformed_requests,
                    error_rate=prev_stats.error_rate,
                )

                percent_changes = PercentChange(
                    requests=_calculate_percent_change(
                        current_stats.total_requests, prev_stats.total_requests
                    ),
                    geo_events=_calculate_percent_change(
                        current_stats.total_geo_events, prev_stats.total_geo_events
                    ),
                    unique_ips=_calculate_percent_change(
                        current_stats.unique_ips, prev_stats.unique_ips
                    ),
                    bytes_sent=_calculate_percent_change(
                        current_stats.total_bytes_sent, prev_stats.total_bytes_sent
                    ),
                    avg_request_time=_calculate_percent_change(
                        current_stats.avg_request_time, prev_stats.avg_request_time
                    ),
                    error_rate=_calculate_percent_change(
                        current_stats.error_rate, prev_stats.error_rate
                    ),
                )

        return SummaryResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            current_period=current_period,
            previous_period=previous_period,
            percent_changes=percent_changes,
        )

    @get("/time-series/requests", description="Get request count time-series for charts.")
    async def get_requests_time_series(
        self,
        hourly_stats_repo: HourlyStatsRepository,
        daily_stats_repo: DailyStatsRepository,
        start_date: Annotated[
            date,
            Parameter(
                description="Start date (ISO 8601)",
                examples=[Example(value="2024-01-01")],
            ),
        ],
        end_date: Annotated[
            date,
            Parameter(
                description="End date (ISO 8601)",
                examples=[Example(value="2024-12-31")],
            ),
        ],
        granularity: Annotated[
            Literal["hourly", "daily"],
            Parameter(
                description="Time granularity for data points",
                default=Granularity.DAILY.value,
            ),
        ] = Granularity.DAILY.value,
    ) -> TimeSeriesResponse:
        """Get request count time-series data for line/bar charts.

        Returns data points with request counts and status code breakdowns.
        """
        start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
        end_dt = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=timezone.utc)

        data_points: list[TimeSeriesDataPoint] = []

        if granularity == Granularity.HOURLY.value:
            stats: Sequence[HourlyStats] = await hourly_stats_repo.get_time_series(start_dt, end_dt)
            for stat in stats:
                total: int = stat.status_2xx + stat.status_3xx + stat.status_4xx + stat.status_5xx
                error_rate: int | float = (stat.status_4xx + stat.status_5xx) / total if total > 0 else 0.0
                data_points.append(
                    TimeSeriesDataPoint(
                        timestamp=stat.hour.isoformat(),
                        total_requests=stat.total_requests,
                        total_geo_events=stat.total_geo_events,
                        total_bytes_sent=stat.total_bytes_sent,
                        status_2xx=stat.status_2xx,
                        status_3xx=stat.status_3xx,
                        status_4xx=stat.status_4xx,
                        status_5xx=stat.status_5xx,
                        error_rate=error_rate,
                    )
                )
        else:
            stats: Sequence[DailyStats] = await daily_stats_repo.get_time_series(start_date, end_date)
            for stat in stats:
                total: int = stat.status_2xx + stat.status_3xx + stat.status_4xx + stat.status_5xx
                error_rate: int | float = (stat.status_4xx + stat.status_5xx) / total if total > 0 else 0.0
                # Convert date to datetime for consistent format
                stat_dt = datetime(stat.date.year, stat.date.month, stat.date.day, tzinfo=timezone.utc)
                data_points.append(
                    TimeSeriesDataPoint(
                        timestamp=stat_dt.isoformat(),
                        total_requests=stat.total_requests,
                        total_geo_events=stat.total_geo_events,
                        total_bytes_sent=stat.total_bytes_sent,
                        status_2xx=stat.status_2xx,
                        status_3xx=stat.status_3xx,
                        status_4xx=stat.status_4xx,
                        status_5xx=stat.status_5xx,
                        error_rate=error_rate,
                    )
                )

        return TimeSeriesResponse(
            granularity=granularity,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            data=data_points,
        )

    @get("/time-series/bandwidth", description="Get bandwidth time-series for charts.")
    async def get_bandwidth_time_series(
        self,
        hourly_stats_repo: HourlyStatsRepository,
        daily_stats_repo: DailyStatsRepository,
        start_date: Annotated[
            date,
            Parameter(
                description="Start date (ISO 8601)",
                examples=[Example(value="2024-01-01")]
            ),
            
        ],
        end_date: Annotated[
            date,
            Parameter(
                description="End date (ISO 8601)",
                examples=[Example(value="2024-12-31")]
            ),
            
        ],
        granularity: Annotated[
            Literal["hourly", "daily"],
            Parameter(description="Time granularity", default=Granularity.DAILY.value),
        ] = Granularity.DAILY.value,
    ) -> BandwidthTimeSeriesResponse:
        """Get bandwidth time-series data for charts.

        Returns bytes sent over time.
        """
        start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
        end_dt = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=timezone.utc)

        data_points: list[BandwidthDataPoint] = []

        if granularity == Granularity.HOURLY.value:
            stats: Sequence[HourlyStats] = await hourly_stats_repo.get_time_series(start_dt, end_dt)
            for stat in stats:
                avg_bytes: int | float = stat.total_bytes_sent / stat.total_requests if stat.total_requests > 0 else 0.0
                data_points.append(
                    BandwidthDataPoint(
                        timestamp=stat.hour.isoformat(),
                        total_bytes_sent=stat.total_bytes_sent,
                        avg_bytes_per_request=avg_bytes,
                    )
                )
        else:
            stats: Sequence[DailyStats] = await daily_stats_repo.get_time_series(start_date, end_date)
            for stat in stats:
                stat_dt = datetime(stat.date.year, stat.date.month, stat.date.day, tzinfo=timezone.utc)
                data_points.append(
                    BandwidthDataPoint(
                        timestamp=stat_dt.isoformat(),
                        total_bytes_sent=stat.total_bytes_sent,
                        avg_bytes_per_request=stat.avg_bytes_per_request,
                    )
                )

        return BandwidthTimeSeriesResponse(
            granularity=granularity,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            data=data_points,
        )

    @get("/time-series/performance", description="Get response time metrics for charts.")
    async def get_performance_time_series(
        self,
        hourly_stats_repo: HourlyStatsRepository,
        daily_stats_repo: DailyStatsRepository,
        start_date: Annotated[
            date,
            Parameter(
                description="Start date (ISO 8601)",
                examples=[Example(value="2024-01-01")]
            )
        ],
        end_date: Annotated[
            date,
            Parameter(
                description="End date (ISO 8601)",
                examples=[Example(value="2024-12-31")]
            ),
        ],
        granularity: Annotated[
            Literal["hourly", "daily"],
            Parameter(description="Time granularity", default=Granularity.DAILY.value),
        ] = Granularity.DAILY.value,
    ) -> PerformanceTimeSeriesResponse:
        """Get response time metrics over time.

        Returns average and max request times.
        """
        start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
        end_dt = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=timezone.utc)

        data_points: list[PerformanceDataPoint] = []

        if granularity == Granularity.HOURLY.value:
            stats: Sequence[HourlyStats] = await hourly_stats_repo.get_time_series(start_dt, end_dt)
            for stat in stats:
                data_points.append(
                    PerformanceDataPoint(
                        timestamp=stat.hour.isoformat(),
                        avg_request_time=stat.avg_request_time,
                        max_request_time=stat.max_request_time,
                    )
                )
        else:
            stats: Sequence[DailyStats] = await daily_stats_repo.get_time_series(start_date, end_date)
            for stat in stats:
                stat_dt = datetime(stat.date.year, stat.date.month, stat.date.day, tzinfo=timezone.utc)
                data_points.append(
                    PerformanceDataPoint(
                        timestamp=stat_dt.isoformat(),
                        avg_request_time=stat.avg_request_time,
                        max_request_time=stat.max_request_time,
                    )
                )

        return PerformanceTimeSeriesResponse(
            granularity=granularity,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            data=data_points,
        )

    @get("/time-series/geo-events", description="Get geo events time-series for charts.")
    async def get_geo_events_time_series(
        self,
        hourly_stats_repo: HourlyStatsRepository,
        daily_stats_repo: DailyStatsRepository,
        start_date: Annotated[
            date,
            Parameter(
                description="Start date (ISO 8601)",
                examples=[Example(value="2024-01-01")],
            ),
        ],
        end_date: Annotated[
            date,
            Parameter(
                description="End date (ISO 8601)",
                examples=[Example(value="2024-12-31")],
            ),
        ],
        granularity: Annotated[
            Literal["hourly", "daily"],
            Parameter(description="Time granularity", default=Granularity.DAILY.value),
        ] = Granularity.DAILY.value,
    ) -> GeoEventsTimeSeriesResponse:
        """Get geo events time-series data.

        Returns geo event counts, unique IPs, and unique countries over time.
        """
        start_dt = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
        end_dt = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59, tzinfo=timezone.utc)

        data_points: list[GeoEventsDataPoint] = []

        if granularity == Granularity.HOURLY.value:
            stats: Sequence[HourlyStats] = await hourly_stats_repo.get_time_series(start_dt, end_dt)
            for stat in stats:
                data_points.append(
                    GeoEventsDataPoint(
                        timestamp=stat.hour.isoformat(),
                        total_geo_events=stat.total_geo_events,
                        unique_ips=stat.unique_ips,
                        unique_countries=stat.unique_countries,
                    )
                )
        else:
            stats: Sequence[DailyStats] = await daily_stats_repo.get_time_series(start_date, end_date)
            for stat in stats:
                stat_dt = datetime(stat.date.year, stat.date.month, stat.date.day, tzinfo=timezone.utc)
                data_points.append(
                    GeoEventsDataPoint(
                        timestamp=stat_dt.isoformat(),
                        total_geo_events=stat.total_geo_events,
                        unique_ips=stat.unique_ips,
                        unique_countries=stat.unique_countries,
                    )
                )

        return GeoEventsTimeSeriesResponse(
            granularity=granularity,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            data=data_points,
        )
