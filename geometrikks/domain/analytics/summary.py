"""The traffic totals shared by analytics and integration responses."""

from geometrikks.domain.analytics.dtos import PeriodSummary
from geometrikks.domain.analytics.repositories import SummaryStats


def period_summary(stats: SummaryStats | None) -> PeriodSummary:
    """Keep empty periods and nullable latency values consistent across callers."""
    if stats is None:
        return PeriodSummary(
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
    return PeriodSummary(
        total_requests=stats.total_log_records,
        timed_requests=stats.timed_requests,
        total_geo_events=stats.total_geo_records,
        unique_ips=stats.unique_ips,
        unique_countries=stats.unique_countries,
        total_bytes_sent=stats.total_bytes_sent,
        avg_bytes_per_request=stats.avg_bytes_per_request,
        status_2xx=stats.status_2xx,
        status_3xx=stats.status_3xx,
        status_4xx=stats.status_4xx,
        status_5xx=stats.status_5xx,
        avg_request_time=stats.avg_request_time,
        max_request_time=stats.max_request_time,
        malformed_requests=stats.malformed_requests,
        error_rate=stats.error_rate,
    )
