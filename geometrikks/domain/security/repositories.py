"""Bulk enrichment lookups joining banned IPs against stored traffic data."""
from __future__ import annotations

import ipaddress
from datetime import datetime, timedelta, timezone

from sqlalchemy import bindparam, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.domain.geo.repositories import StatsGranularity, get_stats_granularity
from geometrikks.domain.security.schemas import IpEnrichment, IpLocation
from geometrikks.server.logging import get_logger

logger = get_logger(__name__)

# Latest-geo lookback: bounds chunk scans on the access_logs hypertable while
# still finding geo data for IPs whose last request predates the 24h window.
GEO_LOOKBACK = timedelta(days=30)

ENRICH_STMT = text(
    """
    SELECT
        host(ip_address) AS ip,
        COUNT(*) FILTER (WHERE timestamp >= :since) AS request_count_24h,
        (array_agg(country_code ORDER BY timestamp DESC)
            FILTER (WHERE country_code IS NOT NULL))[1] AS country_code,
        (array_agg(country_name ORDER BY timestamp DESC)
            FILTER (WHERE country_name IS NOT NULL))[1] AS country_name,
        (array_agg(city ORDER BY timestamp DESC)
            FILTER (WHERE city IS NOT NULL))[1] AS city
    FROM access_logs
    WHERE ip_address = ANY(:ips) AND timestamp >= :lookback
    GROUP BY ip_address
    """
).bindparams(bindparam("ips", type_=postgresql.ARRAY(postgresql.INET)))


class SecurityEnrichmentRepository:
    """Per-IP geo and request-count lookups for the CrowdSec views.

    One bulk query per call, never per-IP round trips: the decisions table
    enriches a whole page at once.
    """

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def enrich(self, ips: list[str]) -> dict[str, IpEnrichment]:
        """Latest known geo plus 24h request count for each IP.

        Non-IP values (CIDRs from Range decisions, country codes, AS numbers)
        are skipped: ``ip_address`` is an INET column and asyncpg would fail
        to encode them. IPs with no stored traffic are absent from the result.
        Result keys are the database's canonical text form of the address.
        """
        valid_ips = [ip for ip in ips if _is_ip(ip)]
        if not valid_ips:
            return {}

        now = datetime.now(timezone.utc)
        rows = await self.session.execute(
            ENRICH_STMT,
            {
                "ips": valid_ips,
                "since": now - timedelta(hours=24),
                "lookback": now - GEO_LOOKBACK,
            },
        )
        return {
            row.ip: IpEnrichment(
                country_code=row.country_code,
                country_name=row.country_name,
                city=row.city,
                request_count_24h=row.request_count_24h,
            )
            for row in rows
        }

    async def locations(
        self,
        ips: list[str],
        *,
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> list[IpLocation]:
        """Latest known coordinates per IP, from stored geo events.

        Same input rules as :meth:`enrich`; IPs never seen in the stored
        traffic are absent from the result. ``start`` defaults to the
        ``GEO_LOOKBACK`` window and ``end`` to now.

        Routing follows the geo query layer: raw ``geo_events`` for windows
        up to 24h (uncompressed chunks, indexed), the ip_location CAGGs
        beyond that. Filtering thousands of banned IPs against raw chunks
        older than the compression threshold decompresses them row by row;
        the CAGGs stay small and uncompressed. Presence on the CAGG paths
        is bucket-resolution, matching the map circles.
        """
        valid_ips = [ip for ip in ips if _is_ip(ip)]
        if not valid_ips:
            return []

        now = datetime.now(timezone.utc)
        start_ts = start if start is not None else now - GEO_LOOKBACK
        end_ts = end if end is not None else now
        granularity = get_stats_granularity(start_ts, end_ts)
        if granularity == StatsGranularity.RAW:
            stmt = LOCATIONS_STMT
        elif granularity == StatsGranularity.HOURLY:
            stmt = HOURLY_LOCATIONS_STMT
            start_ts = start_ts.replace(minute=0, second=0, microsecond=0)
        else:
            stmt = DAILY_LOCATIONS_STMT
            start_ts = start_ts.replace(hour=0, minute=0, second=0, microsecond=0)
        logger.debug(
            "Banned-IP locations via %s source: %d IPs, window %s..%s",
            granularity.value,
            len(valid_ips),
            start_ts,
            end_ts,
        )
        rows = await self.session.execute(
            stmt,
            {"ips": valid_ips, "lookback": start_ts, "until": end_ts},
        )
        return [
            IpLocation(
                ip=row.ip,
                latitude=row.latitude,
                longitude=row.longitude,
                city=row.city,
                country_code=row.country_code,
            )
            for row in rows
        ]


LOCATIONS_STMT = text(
    """
    SELECT DISTINCT ON (ge.ip_address)
        host(ge.ip_address) AS ip,
        gl.latitude,
        gl.longitude,
        gl.city,
        gl.country_code
    FROM geo_events ge
    JOIN geo_locations gl ON gl.id = ge.location_id
    WHERE ge.ip_address = ANY(:ips)
      AND ge.timestamp >= :lookback
      AND ge.timestamp <= :until
    ORDER BY ge.ip_address, ge.timestamp DESC
    """
).bindparams(bindparam("ips", type_=postgresql.ARRAY(postgresql.INET)))


def _cagg_locations_stmt(suffix: str):
    """DISTINCT ON the ip_location CAGG; ties in the latest bucket resolve
    to the most active location."""
    return text(
        f"""
        SELECT DISTINCT ON (s.ip_address)
            host(s.ip_address) AS ip,
            gl.latitude,
            gl.longitude,
            gl.city,
            gl.country_code
        FROM ip_location_{suffix}_stats s
        JOIN geo_locations gl ON gl.id = s.location_id
        WHERE s.ip_address = ANY(:ips)
          AND s.bucket >= :lookback
          AND s.bucket <= :until
        ORDER BY s.ip_address, s.bucket DESC, s.event_count DESC
        """
    ).bindparams(bindparam("ips", type_=postgresql.ARRAY(postgresql.INET)))


HOURLY_LOCATIONS_STMT = _cagg_locations_stmt("hourly")
DAILY_LOCATIONS_STMT = _cagg_locations_stmt("daily")


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True
