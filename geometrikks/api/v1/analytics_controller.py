"""Analytics API endpoints for dashboard data."""

from __future__ import annotations

import ipaddress
from datetime import datetime, timedelta
from typing import Annotated, Literal

from litestar import Controller, get
from litestar.di import NamedDependency, Provide
from litestar.exceptions import ValidationException
from litestar.params import Parameter
from litestar.openapi.spec import Example

from geometrikks.domain.analytics.repositories import (
    AnalyticsFilters,
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
    GeoEventsDataPoint,
    GeoEventsTimeSeriesResponse,
    TimeSeriesDataPoint,
    TimeSeriesResponse,
    TopUrlDTO,
    TopUrlsResponse,
    TopUserAgentDTO,
    TopUserAgentsResponse,
    TopIpDTO,
    TopIpsResponse,
    TopCountryStatsDTO,
    TopCountriesStatsResponse,
    TopCityStatsDTO,
    TopCitiesResponse,
)
from geometrikks.domain.analytics.repositories import StatsGranularity, get_stats_granularity

from geometrikks.api.dependencies import (
    provide_live_stats_repo,
    provide_summary_stats_repo
)


def _calculate_percent_change(current: float, previous: float) -> float | None:
    """Calculate percent change between two values."""
    if previous == 0:
        return None
    return ((current - previous) / previous) * 100


def _build_filters(
    country_code: list[str] | None,
    city: list[str] | None,
    ip_address: list[str] | None,
) -> AnalyticsFilters:
    """Validate filter params; bad IPs become a 400 instead of a DB error."""
    for ip in ip_address or []:
        try:
            ipaddress.ip_address(ip)
        except ValueError as exc:
            raise ValidationException(f"Invalid IP address: {ip!r}") from exc
    return AnalyticsFilters(
        country_codes=country_code or None,
        cities=city or None,
        ip_addresses=ip_address or None,
    )


def _resolve_chart_granularity(
    start: datetime, end: datetime, override: str | None
) -> StatsGranularity:
    """Chart bucket granularity: explicit override wins, else auto-route.

    Only "hourly"/"daily" are accepted from the API, so RAW can never be
    requested; the auto fallback clamps RAW to HOURLY (no raw CAGG exists,
    hourly + real-time aggregation covers <= 24h ranges).
    """
    if override is not None:
        return StatsGranularity(override)
    granularity = get_stats_granularity(start, end)
    if granularity == StatsGranularity.RAW:
        granularity = StatsGranularity.HOURLY
    return granularity


class AnalyticsController(Controller):
    """Analytics endpoints for dashboard data and time-series charts."""

    path = "/api/v1/analytics"
    tags = ["Analytics"]

    dependencies = {
        "live_stats_repo": Provide(provide_live_stats_repo),
        "summary_stats_repo": Provide(provide_summary_stats_repo),
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

    @get("/time-series", description="Per-bucket access-log metrics for charts.")
    async def get_time_series(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
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
        granularity: Annotated[
            Literal["hourly", "daily"] | None,
            Parameter(
                description="Bucket size override. Omit to auto-select "
                "(hourly <= 30 days, daily above). RAW is never available.",
                required=False,
            ),
        ] = None,
        country_code: Annotated[
            list[str] | None,
            Parameter(description="Filter to these ISO country codes (repeatable)", required=False),
        ] = None,
        city: Annotated[
            list[str] | None,
            Parameter(description="Filter to these city names (repeatable)", required=False),
        ] = None,
        ip_address: Annotated[
            list[str] | None,
            Parameter(description="Filter to these client IPs (repeatable)", required=False),
        ] = None,
    ) -> TimeSeriesResponse:
        """Get per-bucket access-log metrics (requests, status, bytes, latency).

        Perf note: when any of country_code/city/ip_address is set, this
        scans raw access_logs instead of the CAGGs (which can't be sliced by
        dimension). Filtered ranges are therefore bounded by
        raw_retention_days (default 180d) and slower than the unfiltered,
        CAGG-backed path - acceptable at homelab volume with chunk exclusion
        (same trade-off as /top-urls).
        """
        filters = _build_filters(country_code, city, ip_address)
        resolved = _resolve_chart_granularity(start_date, end_date, granularity)
        if filters.is_active():
            interval = "1 hour" if resolved == StatsGranularity.HOURLY else "1 day"
            rows = await live_stats_repo.get_time_series(
                start_date, end_date, bucket_interval=interval, filters=filters
            )
        else:
            rows = await summary_stats_repo.get_time_series(
                start_date, end_date, granularity=resolved
            )
        return TimeSeriesResponse(
            granularity=resolved.value,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            data=[
                TimeSeriesDataPoint(
                    timestamp=row.bucket.isoformat(),
                    total_requests=row.total_requests,
                    total_geo_events=0,  # geo series is its own endpoint
                    total_bytes_sent=row.total_bytes,
                    status_2xx=row.status_2xx,
                    status_3xx=row.status_3xx,
                    status_4xx=row.status_4xx,
                    status_5xx=row.status_5xx,
                    error_rate=(row.status_4xx + row.status_5xx) / row.total_requests if row.total_requests else 0.0,
                    avg_request_time=row.avg_request_time,
                    p50_request_time=row.p50_request_time,
                    p95_request_time=row.p95_request_time,
                    p99_request_time=row.p99_request_time,
                )
                for row in rows
            ],
        )

    @get("/geo-time-series", description="Per-bucket geo-event metrics for charts.")
    async def get_geo_time_series(
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
        granularity: Annotated[
            Literal["hourly", "daily"] | None,
            Parameter(
                description="Bucket size override. Omit to auto-select "
                "(hourly <= 30 days, daily above). RAW is never available.",
                required=False,
            ),
        ] = None,
    ) -> GeoEventsTimeSeriesResponse:
        """Get per-bucket geo-event metrics (events, unique IPs/countries/cities)."""
        resolved = _resolve_chart_granularity(start_date, end_date, granularity)
        rows = await summary_stats_repo.get_geo_time_series(start_date, end_date, granularity=resolved)
        return GeoEventsTimeSeriesResponse(
            granularity=resolved.value,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            data=[
                GeoEventsDataPoint(
                    timestamp=row["bucket"].isoformat(),
                    total_geo_events=row["total_events"],
                    unique_ips=row["unique_ips"],
                    unique_countries=row["unique_countries"],
                    unique_cities=row["unique_cities"],
                )
                for row in rows
            ],
        )

    @get("/top-urls", description="Top URLs by hits from raw access logs (time-bounded).")
    async def get_top_urls(
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
        limit: Annotated[
            int,
            Parameter(description="Maximum number of URLs to return", ge=1, le=100),
        ] = 25,
        country_code: Annotated[
            list[str] | None,
            Parameter(description="Filter to these ISO country codes (repeatable)", required=False),
        ] = None,
        city: Annotated[
            list[str] | None,
            Parameter(description="Filter to these city names (repeatable)", required=False),
        ] = None,
        ip_address: Annotated[
            list[str] | None,
            Parameter(description="Filter to these client IPs (repeatable)", required=False),
        ] = None,
    ) -> TopUrlsResponse:
        """Get the top URLs by hit count for a date range."""
        filters = _build_filters(country_code, city, ip_address)
        rows = await live_stats_repo.get_top_urls(start_date, end_date, limit=limit, filters=filters)
        return TopUrlsResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            items=[TopUrlDTO(**vars(r)) for r in rows],
        )

    @get("/top-user-agents", description="Top user agents by hits from raw access logs.")
    async def get_top_user_agents(
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
        limit: Annotated[
            int,
            Parameter(description="Maximum number of user agents to return", ge=1, le=100),
        ] = 25,
        country_code: Annotated[
            list[str] | None,
            Parameter(description="Filter to these ISO country codes (repeatable)", required=False),
        ] = None,
        city: Annotated[
            list[str] | None,
            Parameter(description="Filter to these city names (repeatable)", required=False),
        ] = None,
        ip_address: Annotated[
            list[str] | None,
            Parameter(description="Filter to these client IPs (repeatable)", required=False),
        ] = None,
    ) -> TopUserAgentsResponse:
        """Get the top user agents by hit count for a date range."""
        filters = _build_filters(country_code, city, ip_address)
        rows = await live_stats_repo.get_top_user_agents(start_date, end_date, limit=limit, filters=filters)
        return TopUserAgentsResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            items=[TopUserAgentDTO(**vars(r)) for r in rows],
        )

    @get("/top-ips", description="Top client IPs by hits from raw access logs (time-bounded).")
    async def get_top_ips(
        self,
        live_stats_repo: NamedDependency[LiveStatsRepository],
        start_date: Annotated[
            datetime,
            Parameter(description="Start date (ISO 8601)"),
        ],
        end_date: Annotated[
            datetime,
            Parameter(description="End date (ISO 8601)"),
        ],
        limit: Annotated[
            int,
            Parameter(description="Maximum number of IPs", ge=1, le=100),
        ] = 25,
        country_code: Annotated[
            list[str] | None,
            Parameter(description="Filter to these ISO country codes (repeatable)", required=False),
        ] = None,
        city: Annotated[
            list[str] | None,
            Parameter(description="Filter to these city names (repeatable)", required=False),
        ] = None,
        ip_address: Annotated[
            list[str] | None,
            Parameter(description="Filter to these client IPs (repeatable)", required=False),
        ] = None,
    ) -> TopIpsResponse:
        """Get the top client IPs by hit count for a date range."""
        filters = _build_filters(country_code, city, ip_address)
        rows = await live_stats_repo.get_top_ips(start_date, end_date, limit=limit, filters=filters)
        return TopIpsResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            items=[TopIpDTO(**vars(r)) for r in rows],
        )

    @get("/top-countries", description="Top countries by hits from raw access logs (time-bounded).")
    async def get_top_countries(
        self,
        live_stats_repo: NamedDependency[LiveStatsRepository],
        start_date: Annotated[
            datetime,
            Parameter(description="Start date (ISO 8601)"),
        ],
        end_date: Annotated[
            datetime,
            Parameter(description="End date (ISO 8601)"),
        ],
        limit: Annotated[
            int,
            Parameter(description="Maximum number of countries", ge=1, le=100),
        ] = 25,
        country_code: Annotated[
            list[str] | None,
            Parameter(description="Filter to these ISO country codes (repeatable)", required=False),
        ] = None,
        city: Annotated[
            list[str] | None,
            Parameter(description="Filter to these city names (repeatable)", required=False),
        ] = None,
        ip_address: Annotated[
            list[str] | None,
            Parameter(description="Filter to these client IPs (repeatable)", required=False),
        ] = None,
    ) -> TopCountriesStatsResponse:
        """Get the top countries by hit count for a date range."""
        filters = _build_filters(country_code, city, ip_address)
        rows = await live_stats_repo.get_top_countries(start_date, end_date, limit=limit, filters=filters)
        return TopCountriesStatsResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            items=[TopCountryStatsDTO(**vars(r)) for r in rows],
        )

    @get("/top-cities", description="Top cities by hits from raw access logs (time-bounded).")
    async def get_top_cities(
        self,
        live_stats_repo: NamedDependency[LiveStatsRepository],
        start_date: Annotated[
            datetime,
            Parameter(description="Start date (ISO 8601)"),
        ],
        end_date: Annotated[
            datetime,
            Parameter(description="End date (ISO 8601)"),
        ],
        limit: Annotated[
            int,
            Parameter(description="Maximum number of cities", ge=1, le=100),
        ] = 25,
        country_code: Annotated[
            list[str] | None,
            Parameter(description="Filter to these ISO country codes (repeatable)", required=False),
        ] = None,
        city: Annotated[
            list[str] | None,
            Parameter(description="Filter to these city names (repeatable)", required=False),
        ] = None,
        ip_address: Annotated[
            list[str] | None,
            Parameter(description="Filter to these client IPs (repeatable)", required=False),
        ] = None,
    ) -> TopCitiesResponse:
        """Get the top cities by hit count for a date range."""
        filters = _build_filters(country_code, city, ip_address)
        rows = await live_stats_repo.get_top_cities(start_date, end_date, limit=limit, filters=filters)
        return TopCitiesResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            items=[TopCityStatsDTO(**vars(r)) for r in rows],
        )

