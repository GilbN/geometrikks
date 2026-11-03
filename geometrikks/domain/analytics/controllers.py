"""Analytics API endpoints for dashboard data."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Annotated

from litestar import Controller, get
from litestar.di import NamedDependency, Provide
from litestar.params import QueryParameter, SkipValidation

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
    TopAsnDTO,
    TopAsnsResponse,
    AsnCategoryTotalsDTO,
    TopIpDTO,
    TopIpsResponse,
    TopCountryStatsDTO,
    TopCountriesStatsResponse,
    TopCityStatsDTO,
    TopCitiesResponse,
    IpProfileBucketDTO,
    IpProfileHostDTO,
    IpProfilePathDTO,
    IpProfileResponse,
    IpProfileUserAgentDTO,
)
from geometrikks.domain.analytics.repositories import StatsGranularity, get_stats_granularity
from geometrikks.domain.analytics.asn_classification import classify_asn
from geometrikks.domain.analytics.ip_profile import IpProfile, IpProfileBucket, IpProfileRepository

from geometrikks.domain.analytics.dependencies import (
    provide_ip_profile_repo,
    provide_live_stats_repo,
    provide_summary_stats_repo
)
from geometrikks.domain.drop.dependencies import provide_drop_snapshot
from geometrikks.domain.drop.snapshot import DropSnapshot
from geometrikks.lib.parameters import (
    CityFilter,
    ChartGranularity,
    ComparePrevious,
    CountryCodeFilter,
    EndDate,
    IpAddressExcludeFilter,
    IpAddressFilter,
    StartDate,
    Timezone,
    local_days_edge_note,
)
from geometrikks.lib.validation import validate_ip_address, validate_ip_addresses, validate_timezone


def _calculate_percent_change(current: float, previous: float) -> float | None:
    """Calculate percent change between two values."""
    if previous == 0:
        return None
    return ((current - previous) / previous) * 100


def _optional_percent_change(current: float | None, previous: float | None) -> float | None:
    """Percent change for a figure that is None when nothing was measured."""
    if current is None or previous is None:
        return None
    return _calculate_percent_change(current, previous)


def _build_filters(
    country_code: list[str] | None,
    city: list[str] | None,
    ip_address: list[str] | None,
    ip_address_not_in: list[str] | None = None,
) -> AnalyticsFilters:
    """Validate filter params; bad IPs become a 400 instead of a DB error."""
    validate_ip_addresses((ip_address or []) + (ip_address_not_in or []))
    return AnalyticsFilters(
        country_codes=country_code or None,
        cities=city or None,
        ip_addresses=ip_address or None,
        ip_exclude=ip_address_not_in or None,
    )


def _bucket_dto(bucket: IpProfileBucket) -> IpProfileBucketDTO:
    return IpProfileBucketDTO(
        timestamp=bucket.timestamp.isoformat(),
        hits=bucket.hits,
        error_hits=bucket.error_hits,
    )


def _optional_bucket_dto(bucket: IpProfileBucket | None) -> IpProfileBucketDTO | None:
    return _bucket_dto(bucket) if bucket is not None else None


def _to_ip_profile_response(
    ip_address: str,
    start: datetime,
    end: datetime,
    profile: IpProfile,
    drop_snapshot: DropSnapshot | None = None,
) -> IpProfileResponse:
    """Wire shape for one profile; pure so the mapping is unit-testable."""
    errors = profile.status_4xx + profile.status_5xx
    return IpProfileResponse(
        ip_address=ip_address,
        start_date=start.isoformat(),
        end_date=end.isoformat(),
        total_requests=profile.total_requests,
        status_2xx=profile.status_2xx,
        status_3xx=profile.status_3xx,
        status_4xx=profile.status_4xx,
        status_5xx=profile.status_5xx,
        error_rate=errors / profile.total_requests if profile.total_requests else 0.0,
        total_bytes=profile.total_bytes,
        timed_requests=profile.timed_requests,
        avg_request_time=profile.avg_request_time,
        p95_request_time=profile.p95_request_time,
        first_seen=profile.first_seen.isoformat() if profile.first_seen else None,
        last_seen=profile.last_seen.isoformat() if profile.last_seen else None,
        distinct_paths=profile.distinct_paths,
        malformed_requests=profile.malformed_requests,
        asn=profile.asn,
        asn_organization=profile.asn_organization,
        asn_category=classify_asn(profile.asn, drop_snapshot) if profile.asn is not None else None,
        granularity=profile.granularity,
        series=[_bucket_dto(b) for b in profile.series],
        peak=_optional_bucket_dto(profile.peak),
        hosts=[IpProfileHostDTO(host=h.host, hits=h.hits, error_hits=h.error_hits) for h in profile.hosts],
        paths=[IpProfilePathDTO(host=p.host, url=p.url, hits=p.hits, error_hits=p.error_hits) for p in profile.paths],
        user_agents=[IpProfileUserAgentDTO(user_agent=u.user_agent, hits=u.hits) for u in profile.user_agents],
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


RAW_RETENTION_NOTE = "which go back only ANALYTICS_RAW_RETENTION_DAYS days, 180 by default"
FILTERED_RAW_NOTE = f"A country, city or IP filter makes it read the raw access log rows, {RAW_RETENTION_NOTE}."
WHOLE_BUCKETS_NOTE = (
    "count whole hours or UTC days, from the one that holds `startDate` through the last one that starts "
    "before `endDate`"
)
AGGREGATE_EDGE_NOTE = (
    "Ranges over 24 hours read the hourly aggregates, or the daily ones above 30 days. Those reads "
    f"{WHOLE_BUCKETS_NOTE}."
)


class AnalyticsController(Controller):
    """Analytics endpoints for dashboard data and time-series charts."""

    path = "/analytics"
    tags = ["Analytics"]

    dependencies = {
        "live_stats_repo": Provide(provide_live_stats_repo),
        "summary_stats_repo": Provide(provide_summary_stats_repo),
        "ip_profile_repo": Provide(provide_ip_profile_repo),
        "drop_snapshot": Provide(provide_drop_snapshot),
    }

    @get(
        "/summary",
        summary="Get the traffic summary for a time range",
        description=(
            "Returns request, byte, status class, latency and geo event totals for the range. With "
            "`comparePrevious` it adds the period of the same length that ends just before `startDate`, which "
            "stays null unless the range and that period each have requests or geo events. "
            f"{AGGREGATE_EDGE_NOTE} The unique IP and country counts are then estimates, and "
            "`/api/v1/analytics/live-summary` gives exact figures."
        ),
    )
    async def get_summary(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
        start_date: StartDate,
        end_date: EndDate,
        compare_previous: ComparePrevious = False,
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
                timed_requests=0,
                total_geo_events=0,
                unique_ips=0,
                unique_countries=0,
                total_bytes_sent=0,
                avg_bytes_per_request=0.0,
                status_2xx=0,
                status_3xx=0,
                status_4xx=0,
                status_5xx=0,
                avg_request_time=None,
                max_request_time=None,
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
            timed_requests=current_stats.timed_requests,
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
                    timed_requests=prev_stats.timed_requests,
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
                    avg_request_time=_optional_percent_change(
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

    @get(
        "/live-summary",
        summary="Get the exact traffic summary from the raw rows",
        description=(
            "Returns the same figures as `/api/v1/analytics/summary`, counted from the raw access log and geo event "
            "rows of the exact range, so the unique counts are exact. It gets slower as the range grows, and "
            "the raw rows go back only ANALYTICS_RAW_RETENTION_DAYS days, 180 by default. "
            "`percentChanges.malformedRate` is always null here."
        ),
    )
    async def get_live_summary(
        self,
        live_stats_repo: NamedDependency[LiveStatsRepository],
        start_date: StartDate,
        end_date: EndDate,
        compare_previous: ComparePrevious = False,
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
                timed_requests=0,
                total_geo_events=0,
                unique_ips=0,
                unique_countries=0,
                total_bytes_sent=0,
                avg_bytes_per_request=0.0,
                status_2xx=0,
                status_3xx=0,
                status_4xx=0,
                status_5xx=0,
                avg_request_time=None,
                max_request_time=None,
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
            timed_requests=current_stats.timed_requests,
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
                    timed_requests=prev_stats.timed_requests,
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
                    avg_request_time=_optional_percent_change(
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

    @get(
        "/time-series/cumulative",
        summary="Get running totals of requests, events and bytes",
        description=(
            "Returns one point per bucket with the requests, geo events and bytes sent so far, oldest first. "
            "Buckets are hours for ranges up to 30 days and UTC days above, and hours or days without traffic "
            "have no point. Ranges up to 24 hours count the raw rows of the exact range, and `granularity` reads "
            f"`raw` for them. Longer ranges read the aggregates, which {WHOLE_BUCKETS_NOTE}."
        ),
    )
    async def get_cumulative_time_series(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
        start_date: StartDate,
        end_date: EndDate,
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
                timestamp=row["timestamp"].isoformat(),
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

    @get(
        "/time-series",
        summary="Get request metrics per hour or day",
        description=(
            "Returns requests, bytes, status classes, error rate and latency for each bucket that has "
            "requests, oldest first. Without filters it reads the hourly or daily aggregates at any range "
            f"length, and those reads {WHOLE_BUCKETS_NOTE}. {local_days_edge_note('startDate', 'endDate')} "
            f"{FILTERED_RAW_NOTE} On that filtered path `tz` sets local days at any range length. "
            "`totalGeoEvents` is always 0 here, and `/api/v1/analytics/geo-time-series` has the geo series."
        ),
    )
    async def get_time_series(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
        live_stats_repo: NamedDependency[LiveStatsRepository],
        start_date: StartDate,
        end_date: EndDate,
        granularity: ChartGranularity = None,
        country_code: CountryCodeFilter = None,
        city: CityFilter = None,
        ip_address: IpAddressFilter = None,
        ip_address_not_in: IpAddressExcludeFilter = None,
        tz: Timezone = None,
    ) -> TimeSeriesResponse:
        """Get per-bucket access-log metrics (requests, status, bytes, latency).

        Perf note: when any of country_code/city/ip_address/ip_address_not_in
        is set, this scans raw access_logs instead of the CAGGs (which can't
        be sliced by dimension). Filtered ranges are therefore bounded by
        raw_retention_days (default 180d) and slower than the unfiltered,
        CAGG-backed path - acceptable at homelab volume with chunk exclusion
        (same trade-off as /top-urls).
        """
        filters = _build_filters(country_code, city, ip_address, ip_address_not_in)
        resolved = _resolve_chart_granularity(start_date, end_date, granularity)
        if tz is not None:
            validate_timezone(tz)
        if filters.is_active():
            interval = "1 hour" if resolved == StatsGranularity.HOURLY else "1 day"
            rows = await live_stats_repo.get_time_series(
                start_date, end_date, bucket_interval=interval, filters=filters, tz=tz
            )
        else:
            rows = await summary_stats_repo.get_time_series(
                start_date, end_date, granularity=resolved, tz=tz
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
                    timed_requests=row.timed_requests,
                    avg_request_time=row.avg_request_time,
                    p50_request_time=row.p50_request_time,
                    p95_request_time=row.p95_request_time,
                    p99_request_time=row.p99_request_time,
                )
                for row in rows
            ],
        )

    @get(
        "/geo-time-series",
        summary="Get geo event counts per hour or day",
        description=(
            "Returns geo events and unique IPs, countries and cities for each bucket that has events, oldest "
            "first. It reads the hourly or daily aggregates at any range length, so the unique counts are "
            f"estimates, and those reads {WHOLE_BUCKETS_NOTE}. {local_days_edge_note('startDate', 'endDate')}"
        ),
    )
    async def get_geo_time_series(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
        start_date: StartDate,
        end_date: EndDate,
        granularity: ChartGranularity = None,
        tz: Timezone = None,
    ) -> GeoEventsTimeSeriesResponse:
        """Get per-bucket geo-event metrics (events, unique IPs/countries/cities)."""
        resolved = _resolve_chart_granularity(start_date, end_date, granularity)
        if tz is not None:
            validate_timezone(tz)
        rows = await summary_stats_repo.get_geo_time_series(
            start_date, end_date, granularity=resolved, tz=tz
        )
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

    @get(
        "/top-urls",
        summary="List the most requested URLs",
        description=(
            "Returns host and path pairs ordered by hits, with error hits, bytes and the average request time. "
            f"Lines without a path are left out. {FILTERED_RAW_NOTE}"
        ),
    )
    async def get_top_urls(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
        start_date: StartDate,
        end_date: EndDate,
        limit: Annotated[
            int,
            QueryParameter(description="How many URLs to return, from 1 to 100. Defaults to 25.", ge=1, le=100),
        ] = 25,
        country_code: CountryCodeFilter = None,
        city: CityFilter = None,
        ip_address: IpAddressFilter = None,
        ip_address_not_in: IpAddressExcludeFilter = None,
    ) -> TopUrlsResponse:
        """Get the top URLs by hit count for a date range.

        Perf note: filtered queries scan raw access_logs and are bounded by
        raw_retention_days (same trade-off as filtered /time-series).
        """
        filters = _build_filters(country_code, city, ip_address, ip_address_not_in)
        rows = await summary_stats_repo.get_top_urls(start_date, end_date, limit=limit, filters=filters)
        return TopUrlsResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            items=[TopUrlDTO(**vars(r)) for r in rows],
        )

    @get(
        "/top-user-agents",
        summary="List the most common user agents",
        description=(
            "Returns user agent strings ordered by hits. Lines without a user agent are left out. "
            f"{FILTERED_RAW_NOTE}"
        ),
    )
    async def get_top_user_agents(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
        start_date: StartDate,
        end_date: EndDate,
        limit: Annotated[
            int,
            QueryParameter(description="How many user agents to return, from 1 to 100. Defaults to 25.", ge=1, le=100),
        ] = 25,
        country_code: CountryCodeFilter = None,
        city: CityFilter = None,
        ip_address: IpAddressFilter = None,
        ip_address_not_in: IpAddressExcludeFilter = None,
    ) -> TopUserAgentsResponse:
        """Get the top user agents by hit count for a date range.

        Perf note: filtered queries scan raw access_logs and are bounded by
        raw_retention_days (same trade-off as filtered /time-series).
        """
        filters = _build_filters(country_code, city, ip_address, ip_address_not_in)
        rows = await summary_stats_repo.get_top_user_agents(start_date, end_date, limit=limit, filters=filters)
        return TopUserAgentsResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            items=[TopUserAgentDTO(**vars(r)) for r in rows],
        )

    @get(
        "/top-asns",
        summary="List the networks that send the most requests",
        description=(
            "Returns autonomous systems ordered by hits, each with a category. `categories` adds up every ASN "
            "in the range, not only the top `limit`. `totalRequests` and `totalBytes` count every request, so "
            "requests without ASN data count in them but in no category. "
            f"{FILTERED_RAW_NOTE}"
        ),
    )
    async def get_top_asns(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
        drop_snapshot: NamedDependency[SkipValidation[DropSnapshot]],
        start_date: StartDate,
        end_date: EndDate,
        limit: Annotated[
            int,
            QueryParameter(description="How many ASNs to return, from 1 to 100. Defaults to 25.", ge=1, le=100),
        ] = 25,
        country_code: CountryCodeFilter = None,
        city: CityFilter = None,
        ip_address: IpAddressFilter = None,
        ip_address_not_in: IpAddressExcludeFilter = None,
    ) -> TopAsnsResponse:
        """Top ASNs by hit count plus category totals for a date range.

        Category totals cover every ASN in the range; ``items`` is the top N
        slice. Filtered queries scan raw access_logs, so they see at most
        raw_retention_days of history.
        """
        filters = _build_filters(country_code, city, ip_address, ip_address_not_in)
        rows = await summary_stats_repo.get_top_asns(start_date, end_date, filters=filters)
        # The categories cover only rows with ASN data; the UI reports
        # coverage against these totals.
        total_requests, total_bytes = await summary_stats_repo.get_request_totals(
            start_date, end_date, filters=filters
        )

        totals: dict[str, list[int]] = {"drop": [0, 0], "hosting": [0, 0], "other": [0, 0]}
        items: list[TopAsnDTO] = []
        drop_asn_count = 0
        for row in rows:
            category = classify_asn(row.asn, drop_snapshot)
            if category == "drop":
                drop_asn_count += 1
            totals[category][0] += row.hits
            totals[category][1] += row.total_bytes
            if len(items) < limit:
                items.append(TopAsnDTO(
                    asn=row.asn,
                    organization=row.organization,
                    hits=row.hits,
                    total_bytes=row.total_bytes,
                    category=category,
                ))
        return TopAsnsResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            total_requests=total_requests,
            total_bytes=total_bytes,
            items=items,
            categories=[
                *(
                    [
                        AsnCategoryTotalsDTO(
                            category="drop",
                            hits=totals["drop"][0],
                            total_bytes=totals["drop"][1],
                        )
                    ]
                    if drop_snapshot.asns_loaded
                    else []
                ),
                AsnCategoryTotalsDTO(
                    category="hosting",
                    hits=totals["hosting"][0],
                    total_bytes=totals["hosting"][1],
                ),
                AsnCategoryTotalsDTO(
                    category="other",
                    hits=totals["other"][0],
                    total_bytes=totals["other"][1],
                ),
            ],
            drop_asn_count=drop_asn_count if drop_snapshot.asns_loaded else None,
        )

    @get(
        "/top-ips",
        summary="List the client IPs with the most requests",
        description=(
            "Returns client IPs ordered by hits, with error hits, bytes and the IP's country and city. A "
            "filter reads the per-IP aggregates, so unlike the URL and user agent lists it reaches past "
            "ANALYTICS_RAW_RETENTION_DAYS."
        ),
    )
    async def get_top_ips(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
        start_date: StartDate,
        end_date: EndDate,
        limit: Annotated[
            int,
            QueryParameter(description="How many IPs to return, from 1 to 100. Defaults to 25.", ge=1, le=100),
        ] = 25,
        country_code: CountryCodeFilter = None,
        city: CityFilter = None,
        ip_address: IpAddressFilter = None,
        ip_address_not_in: IpAddressExcludeFilter = None,
    ) -> TopIpsResponse:
        """Get the top client IPs by hit count for a date range."""
        filters = _build_filters(country_code, city, ip_address, ip_address_not_in)
        rows = await summary_stats_repo.get_top_ips(start_date, end_date, limit=limit, filters=filters)
        return TopIpsResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            items=[TopIpDTO(**vars(r)) for r in rows],
        )

    @get(
        "/top-countries",
        summary="List the countries with the most requests",
        description=(
            "Returns countries ordered by hits, with the number of distinct client IPs from each. Requests "
            "without a country are left out."
        ),
    )
    async def get_top_countries(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
        start_date: StartDate,
        end_date: EndDate,
        limit: Annotated[
            int,
            QueryParameter(description="How many countries to return, from 1 to 100. Defaults to 25.", ge=1, le=100),
        ] = 25,
        country_code: CountryCodeFilter = None,
        city: CityFilter = None,
        ip_address: IpAddressFilter = None,
        ip_address_not_in: IpAddressExcludeFilter = None,
    ) -> TopCountriesStatsResponse:
        """Get the top countries by hit count for a date range."""
        filters = _build_filters(country_code, city, ip_address, ip_address_not_in)
        rows = await summary_stats_repo.get_top_countries(start_date, end_date, limit=limit, filters=filters)
        return TopCountriesStatsResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            items=[TopCountryStatsDTO(**vars(r)) for r in rows],
        )

    @get(
        "/top-cities",
        summary="List the cities with the most requests",
        description=(
            "Returns cities ordered by hits, with the number of distinct client IPs from each. Requests "
            "without a city are left out, and cities with the same name in different countries count as one."
        ),
    )
    async def get_top_cities(
        self,
        summary_stats_repo: NamedDependency[SummaryStatsRepository],
        start_date: StartDate,
        end_date: EndDate,
        limit: Annotated[
            int,
            QueryParameter(description="How many cities to return, from 1 to 100. Defaults to 25.", ge=1, le=100),
        ] = 25,
        country_code: CountryCodeFilter = None,
        city: CityFilter = None,
        ip_address: IpAddressFilter = None,
        ip_address_not_in: IpAddressExcludeFilter = None,
    ) -> TopCitiesResponse:
        """Get the top cities by hit count for a date range."""
        filters = _build_filters(country_code, city, ip_address, ip_address_not_in)
        rows = await summary_stats_repo.get_top_cities(start_date, end_date, limit=limit, filters=filters)
        return TopCitiesResponse(
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            items=[TopCityStatsDTO(**vars(r)) for r in rows],
        )

    @get(
        "/ip-profile",
        summary="Get the access log profile of one IP",
        description=(
            "Returns totals, status classes, latency, first and last seen, the top 5 hosts and paths, the top 3 "
            "user agents and a hit series for one client IP. The series has hourly buckets for ranges up to 7 "
            "days and daily buckets above, and `tz` sets local days at any range length. It reads the raw rows, "
            f"{RAW_RETENTION_NOTE}. An IP without requests in the range gets zero request counts and empty lists, not "
            "a 404."
        ),
    )
    async def get_ip_profile(
        self,
        ip_profile_repo: NamedDependency[IpProfileRepository],
        drop_snapshot: NamedDependency[SkipValidation[DropSnapshot]],
        start_date: StartDate,
        end_date: EndDate,
        ip_address: Annotated[
            str,
            QueryParameter(
                name="ipAddress",
                description="The client IP to profile. A value that is not an IP gets a 400.",
            ),
        ],
        tz: Timezone = None,
    ) -> IpProfileResponse:
        """Totals, sparkline, hosts, paths and user agents for one IP.

        Zero rows in range return a zeroed profile, not a 404.
        """
        validate_ip_address(ip_address)
        if tz is not None:
            validate_timezone(tz)
        profile = await ip_profile_repo.get_profile(ip_address, start_date, end_date, tz=tz)
        return _to_ip_profile_response(ip_address, start_date, end_date, profile, drop_snapshot)

