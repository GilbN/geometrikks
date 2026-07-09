"""Analytics API endpoints for dashboard data."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Annotated

from litestar import Controller, get
from litestar.di import NamedDependency, Provide
from litestar.params import Parameter
from litestar.openapi.spec import Example

from geometrikks.domain.analytics.repositories import (
    LiveStatsRepository,
    SummaryStatsRepository,
    SummaryStats,
)
from geometrikks.domain.analytics.dtos import (
    SummaryResponse,
    PeriodSummary,
    PercentChange,
    CumulativeDataPoint,
    CumulativeTimeSeriesResponse,
)
from geometrikks.domain.analytics.repositories import get_stats_granularity

from geometrikks.api.dependencies import (
    provide_live_stats_repo,
    provice_summary_stats_repo
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
        "live_stats_repo": Provide(provide_live_stats_repo),
        "summary_stats_repo": Provide(provice_summary_stats_repo),
    }

    @get("/summary", description="Get summary statistics for dashboard header cards.")
    async def get_summary(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
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
            ),
        ] = False,
    ) -> SummaryResponse:
        """Get aggregated summary statistics for a date range.

        Ideal for populating dashboard header cards with key metrics.
        Optionally includes comparison with the previous period.
        """

        # Get current period stats
        current_stats: SummaryStats | None = await summary_stats_repo.get_summary(start_date, end_date)

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
            total_requests=current_stats.total_log_records,
            total_geo_events=current_stats.total_geo_records,
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

            prev_stats: SummaryStats | None = await summary_stats_repo.get_summary(prev_start, prev_end)

            if prev_stats:
                previous_period = PeriodSummary(
                    total_requests=prev_stats.total_log_records,
                    total_geo_events=prev_stats.total_geo_records,
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
                    log_records=_calculate_percent_change(
                        current_stats.total_log_records, prev_stats.total_log_records
                    ),
                    geo_records=_calculate_percent_change(
                        current_stats.total_geo_records, prev_stats.total_geo_records
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
                    malformed_rate=_calculate_percent_change(
                        current_stats.malformed_requests, prev_stats.malformed_requests
                    ),
                )

        return SummaryResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            current_period=current_period,
            previous_period=previous_period,
            percent_changes=percent_changes,
        )

    @get("/live-summary", description="Get live summary statistics by querying raw data tables.")
    async def get_live_summary(
        self,
        live_stats_repo: NamedDependency[LiveStatsRepository],
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
            ),
        ] = False,
    ) -> SummaryResponse:
        """Get live summary statistics by querying raw data tables.

        Unlike /summary which uses pre-aggregated HourlyStats, this endpoint
        queries AccessLog, GeoEvent, and AccessLogDebug directly.
        This provides the most up-to-date data but may be slower for large datasets.

        Note: This endpoint may be slower than /summary for large datasets.
        """

        # Get current period stats from live data
        current_stats: SummaryStats | None = await live_stats_repo.get_summary(start_date, end_date)

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
            total_requests=current_stats.total_log_records,
            total_geo_events=current_stats.total_geo_records,
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
            # Calculate previous period of same length
            period_length: timedelta = end_date - start_date
            prev_end: datetime = start_date - timedelta(seconds=1)
            prev_start: datetime = prev_end - period_length

            prev_stats: SummaryStats | None = await live_stats_repo.get_summary(prev_start, prev_end)

            if prev_stats:
                previous_period = PeriodSummary(
                    total_requests=prev_stats.total_log_records,
                    total_geo_events=prev_stats.total_geo_records,
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
                    log_records=_calculate_percent_change(
                        current_stats.total_log_records, prev_stats.total_log_records
                    ),
                    geo_records=_calculate_percent_change(
                        current_stats.total_geo_records, prev_stats.total_geo_records
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

    @get("/time-series/cumulative", description="Get cumulative time series data for area charts.")
    async def get_cumulative_time_series(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
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
    ) -> CumulativeTimeSeriesResponse:
        """Get cumulative time series data for area charts.

        Returns running totals for geo events, access logs, and bytes
        that reset at the start of the selected time range.

        Routes to optimal source based on time range:
        - ≤ 24 hours: RAW tables bucketed by hour
        - > 24 hours, ≤ 30 days: hourly CAGGs
        - > 30 days: daily CAGGs
        """
        cumulative_data = await summary_stats_repo.get_cumulative_time_series(
            start_date, end_date
        )

        granularity = get_stats_granularity(start_date, end_date)

        data_points = [
            CumulativeDataPoint(
                timestamp=row["timestamp"].isoformat() if hasattr(row["timestamp"], "isoformat") else str(row["timestamp"]),
                cumulative_geo_events=int(row["cumulative_geo_events"]),
                cumulative_access_logs=int(row["cumulative_access_logs"]),
                cumulative_bytes=int(row["cumulative_bytes"]),
            )
            for row in cumulative_data
        ]

        return CumulativeTimeSeriesResponse(
            granularity=granularity.value,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            data=data_points,
        )

