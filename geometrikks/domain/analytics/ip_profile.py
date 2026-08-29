"""Per-IP access-log profile for the IP inspector sheet.

Raw-only on purpose: the CAGGs carry no IP dimension, so this always goes
straight to ``access_logs``. Six sequential statements per profile, each
filtered on ``ip_address``. Chunks still on the recent, uncompressed side
get an indexed lookup; ``server/timescale.py`` compresses ``access_logs``
past ``ANALYTICS_COMPRESSION_AFTER_DAYS`` with ``compress_orderby =
'timestamp DESC'`` and no ``compress_segmentby``, so older chunks are
decompressed and filtered row by row instead. That is why this lives
outside ``repositories.py``, whose job is stitching CAGG reads with raw
tails.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.server.timescale import LATENCY_FILTER

BucketWidth = Literal["hourly", "daily"]

# A sparkline at sheet width is unreadable past ~170 bars; the charts
# switch at 30 days but that would be 720 hourly buckets here.
HOURLY_MAX_SPAN = timedelta(days=7)
HOST_LIMIT = 5
PATH_LIMIT = 5
USER_AGENT_LIMIT = 3

_BUCKET_INTERVAL: dict[BucketWidth, str] = {"hourly": "1 hour", "daily": "1 day"}


def profile_bucket_width(start: datetime, end: datetime) -> BucketWidth:
    """Hourly buckets up to and including seven days, daily above."""
    return "hourly" if end - start <= HOURLY_MAX_SPAN else "daily"


@dataclass(frozen=True)
class IpProfileBucket:
    timestamp: datetime
    hits: int
    error_hits: int


@dataclass(frozen=True)
class IpProfileHost:
    host: str | None
    hits: int
    error_hits: int


@dataclass(frozen=True)
class IpProfilePath:
    host: str | None
    url: str
    hits: int
    error_hits: int


@dataclass(frozen=True)
class IpProfileUserAgent:
    user_agent: str
    hits: int


@dataclass
class IpProfile:
    """Everything the sheet shows from access_logs for one IP and range."""

    total_requests: int = 0
    status_2xx: int = 0
    status_3xx: int = 0
    status_4xx: int = 0
    status_5xx: int = 0
    total_bytes: int = 0
    timed_requests: int = 0
    avg_request_time: float | None = None
    p95_request_time: float | None = None
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    distinct_paths: int = 0
    malformed_requests: int = 0
    asn: int | None = None
    asn_organization: str | None = None
    granularity: BucketWidth = "hourly"
    series: list[IpProfileBucket] = field(default_factory=list)
    hosts: list[IpProfileHost] = field(default_factory=list)
    paths: list[IpProfilePath] = field(default_factory=list)
    user_agents: list[IpProfileUserAgent] = field(default_factory=list)

    @property
    def peak(self) -> IpProfileBucket | None:
        """Busiest bucket; the earliest one on a tie, since series is ascending."""
        # max(..., default=None) trips a ty overload-resolution bug that
        # infers the lambda's parameter as IpProfileBucket | None.
        if not self.series:
            return None
        return max(self.series, key=lambda b: b.hits)


_WINDOW = (
    "WHERE ip_address = CAST(:ip AS inet) "
    "AND timestamp >= :start AND timestamp < :end"
)

_TOTALS = text(f"""
    SELECT
        COUNT(*) AS total_requests,
        COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS status_2xx,
        COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) AS status_3xx,
        COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS status_4xx,
        COUNT(*) FILTER (WHERE status_code >= 500 AND status_code < 600) AS status_5xx,
        COALESCE(SUM(bytes_sent), 0) AS total_bytes,
        COUNT(request_time) FILTER (WHERE {LATENCY_FILTER}) AS timed_requests,
        AVG(request_time) FILTER (WHERE {LATENCY_FILTER}) AS avg_request_time,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY request_time)
            FILTER (WHERE {LATENCY_FILTER}) AS p95_request_time,
        MIN(timestamp) AS first_seen,
        MAX(timestamp) AS last_seen,
        COUNT(DISTINCT url) AS distinct_paths
    FROM access_logs
    {_WINDOW}
""")

# created_at, not log_timestamp: malformed lines often carry no parsable
# timestamp. The summary card counts them the same way.
_MALFORMED = text("""
    SELECT COUNT(*)
    FROM access_log_debug
    WHERE ip_address = CAST(:ip AS inet)
      AND is_malformed
      AND created_at >= :start AND created_at < :end
""")

_ASN = text(f"""
    SELECT autonomous_system_number, autonomous_system_organization
    FROM access_logs
    {_WINDOW}
      AND autonomous_system_number IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT 1
""")

_HOSTS = text(f"""
    SELECT host,
           COUNT(*) AS hits,
           COUNT(*) FILTER (WHERE status_code >= 400) AS error_hits
    FROM access_logs
    {_WINDOW}
    GROUP BY host
    ORDER BY hits DESC, host NULLS LAST
    LIMIT :limit
""")

_PATHS = text(f"""
    SELECT host,
           url,
           COUNT(*) AS hits,
           COUNT(*) FILTER (WHERE status_code >= 400) AS error_hits
    FROM access_logs
    {_WINDOW}
      AND url IS NOT NULL
    GROUP BY host, url
    ORDER BY hits DESC, host NULLS LAST, url
    LIMIT :limit
""")

_USER_AGENTS = text(f"""
    SELECT user_agent, COUNT(*) AS hits
    FROM access_logs
    {_WINDOW}
      AND user_agent IS NOT NULL
    GROUP BY user_agent
    ORDER BY hits DESC, user_agent
    LIMIT :limit
""")


def _series_stmt(width: BucketWidth):
    # The interval comes from a two-entry map, never from the request. Daily
    # buckets are local days in the caller's zone, like the analytics charts;
    # hours are the same on every clock, so hourly buckets stay plain.
    bucket = (
        "time_bucket('1 day', timestamp, CAST(:tz AS TEXT))"
        if width == "daily"
        else f"time_bucket('{_BUCKET_INTERVAL[width]}', timestamp)"
    )
    return text(f"""
        SELECT {bucket} AS bucket,
               COUNT(*) AS hits,
               COUNT(*) FILTER (WHERE status_code >= 400) AS error_hits
        FROM access_logs
        {_WINDOW}
        GROUP BY bucket
        ORDER BY bucket
    """)


class IpProfileRepository:
    """Seven statements per profile, each bounded to one indexed IP."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_profile(
        self, ip: str, start: datetime, end: datetime, tz: str | None = None
    ) -> IpProfile:
        params = {"ip": ip, "start": start, "end": end}
        profile = IpProfile(granularity=profile_bucket_width(start, end))

        totals = (await self.session.execute(_TOTALS, params)).one()
        malformed = (await self.session.execute(_MALFORMED, params)).scalar_one()
        profile.malformed_requests = int(malformed)
        if not totals.total_requests:
            return profile

        profile.total_requests = int(totals.total_requests)
        profile.status_2xx = int(totals.status_2xx)
        profile.status_3xx = int(totals.status_3xx)
        profile.status_4xx = int(totals.status_4xx)
        profile.status_5xx = int(totals.status_5xx)
        profile.total_bytes = int(totals.total_bytes)
        profile.timed_requests = int(totals.timed_requests)
        profile.avg_request_time = (
            float(totals.avg_request_time) if totals.avg_request_time is not None else None
        )
        profile.p95_request_time = (
            float(totals.p95_request_time) if totals.p95_request_time is not None else None
        )
        profile.first_seen = totals.first_seen
        profile.last_seen = totals.last_seen
        profile.distinct_paths = int(totals.distinct_paths)

        asn_row = (await self.session.execute(_ASN, params)).one_or_none()
        if asn_row is not None:
            profile.asn = int(asn_row.autonomous_system_number)
            profile.asn_organization = asn_row.autonomous_system_organization

        series_params = {**params, "tz": tz or "UTC"} if profile.granularity == "daily" else params
        series = await self.session.execute(_series_stmt(profile.granularity), series_params)
        profile.series = [
            IpProfileBucket(timestamp=r.bucket, hits=int(r.hits), error_hits=int(r.error_hits))
            for r in series.fetchall()
        ]

        hosts = await self.session.execute(_HOSTS, {**params, "limit": HOST_LIMIT})
        profile.hosts = [
            IpProfileHost(host=r.host, hits=int(r.hits), error_hits=int(r.error_hits))
            for r in hosts.fetchall()
        ]

        paths = await self.session.execute(_PATHS, {**params, "limit": PATH_LIMIT})
        profile.paths = [
            IpProfilePath(host=r.host, url=r.url, hits=int(r.hits), error_hits=int(r.error_hits))
            for r in paths.fetchall()
        ]

        agents = await self.session.execute(_USER_AGENTS, {**params, "limit": USER_AGENT_LIMIT})
        profile.user_agents = [
            IpProfileUserAgent(user_agent=r.user_agent, hits=int(r.hits))
            for r in agents.fetchall()
        ]
        return profile
