"""Bulk enrichment lookups joining banned IPs against stored traffic data."""
from __future__ import annotations

import ipaddress
from datetime import datetime, timedelta, timezone

from sqlalchemy import bindparam, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.domain.security.schemas import IpEnrichment

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


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True
