"""Bulk enrichment lookups joining banned IPs against stored traffic data."""
from __future__ import annotations

import ipaddress
from datetime import datetime, timedelta, timezone

from sqlalchemy import bindparam, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.domain.geo.repositories import (
    StatsGranularity,
    get_stats_granularity,
    stitch_params,
    stitched_ip_location_cte,
)
from geometrikks.domain.geo.schemas import GeoEventFilters
from geometrikks.lib.time import ensure_utc
from geometrikks.domain.security.schemas import DropNetworkHits, DropNetworkOrigin, IpEnrichment, IpLocation
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
        country_codes: list[str] | None = None,
        cities: list[str] | None = None,
        servers: list[str] | None = None,
    ) -> list[IpLocation]:
        """One observed location per IP, with its event total, in the
        filtered ``[start, end)`` window.

        Same input rules as :meth:`enrich`; IPs never seen in the matching
        traffic are absent. ``start`` defaults to the ``GEO_LOOKBACK`` window
        and ``end`` to now.

        Routing follows the geo query layer. Windows up to 24h read raw
        ``geo_events``; longer ones read the per-IP CAGGs stitched with raw
        edge slices. On the CAGG path the newest bucket wins and ties inside
        it go to the busiest location, so the result is an observed location,
        not an exact last hit. A server filter forces the raw path like
        every other per-IP query, because the CAGGs carry server sets, not
        counts, and buckets older than the server backfill carry none at all.
        """
        valid_ips = [ip for ip in ips if _is_ip(ip)]
        now = datetime.now(timezone.utc)
        start_ts = ensure_utc(start) if start is not None else now - GEO_LOOKBACK
        end_ts = ensure_utc(end) if end is not None else now
        if not valid_ips or start_ts >= end_ts:
            return []

        filters = GeoEventFilters(country_codes=country_codes, cities=cities, servers=servers)
        granularity = get_stats_granularity(start_ts, end_ts)
        if granularity == StatsGranularity.RAW or filters.forces_raw:
            granularity = StatsGranularity.RAW
            filter_sql, params = filters.sql_conditions("ge", "gl")
            params.update(start=start_ts, end=end_ts)
            stmt = text(f"""
                SELECT DISTINCT ON (ge.ip_address)
                    host(ge.ip_address) AS ip, gl.id AS location_id,
                    gl.latitude, gl.longitude, gl.city, gl.country_code,
                    COUNT(*) OVER (PARTITION BY ge.ip_address) AS event_count
                FROM geo_events ge
                JOIN geo_locations gl ON gl.id = ge.location_id
                WHERE ge.ip_address = ANY(:ips)
                  AND ge.timestamp >= :start AND ge.timestamp < :end
                  {filter_sql}
                ORDER BY ge.ip_address, ge.timestamp DESC, gl.id
            """)
        else:
            filter_sql, params = filters.sql_conditions("c", "gl", asn_column="asn")
            params.update(stitch_params(start_ts, end_ts, granularity))
            stmt = text(f"""
                {stitched_ip_location_cte(granularity)}
                SELECT DISTINCT ON (c.ip_address)
                    host(c.ip_address) AS ip, gl.id AS location_id,
                    gl.latitude, gl.longitude, gl.city, gl.country_code,
                    SUM(c.event_count) OVER (PARTITION BY c.ip_address) AS event_count
                FROM combined c
                JOIN geo_locations gl ON gl.id = c.location_id
                WHERE c.ip_address = ANY(:ips)
                  {filter_sql}
                ORDER BY c.ip_address, c.last_seen DESC, c.event_count DESC, gl.id
            """)
        params["ips"] = valid_ips
        logger.debug(
            "Banned-IP locations via %s source: %d IPs, window %s..%s",
            granularity.value, len(valid_ips), start_ts, end_ts,
        )
        rows = await self.session.execute(
            stmt.bindparams(bindparam("ips", type_=postgresql.ARRAY(postgresql.INET))), params,
        )
        return [
            IpLocation(
                ip=row.ip, location_id=row.location_id,
                latitude=row.latitude, longitude=row.longitude,
                city=row.city, country_code=row.country_code,
                event_count=int(row.event_count),
            )
            for row in rows
        ]


DROP_ORIGINS_STMT = text(
    """
    SELECT
        dn.cidr::text AS cidr,
        al.autonomous_system_number AS asn,
        al.autonomous_system_organization AS as_org,
        COUNT(*) AS row_count,
        MAX(al.timestamp) AS last_seen
    FROM drop_networks dn
    JOIN access_logs al ON al.ip_address <<= dn.cidr
    WHERE dn.cidr = ANY(:cidrs) AND al.timestamp >= :start AND al.timestamp < :end
    GROUP BY dn.cidr, al.autonomous_system_number, al.autonomous_system_organization
    """
).bindparams(bindparam("cidrs", type_=postgresql.ARRAY(postgresql.CIDR)))


class DropTrafficRepository:
    """Access-log traffic from the networks on the DROP list."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def network_hits(self, start: datetime, end: datetime) -> list[DropNetworkHits]:
        """Hits and distinct IPs per DROP network with traffic in ``[start, end)``.

        Rows come busiest first. Windows over 24h read the per-IP CAGG and
        stitch raw access_logs for the edges the whole buckets do not cover,
        the way ``/analytics/top-ips`` does, so the result equals a raw scan.
        """
        start_ts, end_ts = ensure_utc(start), ensure_utc(end)
        granularity = get_stats_granularity(start_ts, end_ts)
        if granularity == StatsGranularity.RAW:
            params: dict = {"start": start_ts, "end": end_ts, "a_start": end_ts, "a_end": end_ts}
            cagg_leg = ""
        else:
            params = stitch_params(start_ts, end_ts, granularity)
            cagg_leg = f"""
                SELECT dn.cidr, dn.sbl_id, s.ip_address, s.hits
                FROM log_ip_{granularity.value}_stats s
                JOIN drop_networks dn ON s.ip_address <<= dn.cidr
                WHERE s.bucket >= :a_start AND s.bucket < :a_end
                UNION ALL
            """
        stmt = text(f"""
            WITH combined AS (
                {cagg_leg}
                SELECT dn.cidr, dn.sbl_id, al.ip_address, CAST(1 AS BIGINT) AS hits
                FROM access_logs al
                JOIN drop_networks dn ON al.ip_address <<= dn.cidr
                WHERE al.timestamp >= :start AND al.timestamp < :a_start
                UNION ALL
                SELECT dn.cidr, dn.sbl_id, al.ip_address, CAST(1 AS BIGINT) AS hits
                FROM access_logs al
                JOIN drop_networks dn ON al.ip_address <<= dn.cidr
                WHERE al.timestamp >= :a_end AND al.timestamp < :end
            )
            SELECT
                cidr::text AS cidr,
                sbl_id,
                CAST(SUM(hits) AS BIGINT) AS hits,
                CAST(COUNT(DISTINCT ip_address) AS BIGINT) AS ips
            FROM combined
            GROUP BY cidr, sbl_id
            ORDER BY hits DESC, cidr
        """)
        result = await self.session.execute(stmt, params)
        return [
            DropNetworkHits(cidr=row.cidr, sbl_id=row.sbl_id, hits=row.hits, ips=row.ips)
            for row in result
        ]

    async def network_origins(
        self, cidrs: list[str], start: datetime, end: datetime
    ) -> dict[str, DropNetworkOrigin]:
        """Most common ASN and the newest request per network, from raw access_logs.

        Takes the page's networks only. The ASN and its organization come from
        the same rows, so the pair is always one real ASN. A network whose raw
        rows have aged out of retention is absent from the result.
        """
        if not cidrs:
            return {}
        result = await self.session.execute(
            DROP_ORIGINS_STMT, {"cidrs": cidrs, "start": ensure_utc(start), "end": ensure_utc(end)}
        )
        row_counts_by_asn: dict[str, dict[tuple[int | None, str | None], int]] = {}
        newest_by_cidr: dict[str, datetime] = {}
        for row in result:
            asn_counts = row_counts_by_asn.setdefault(row.cidr, {})
            asn_counts[(row.asn, row.as_org)] = row.row_count
            newest_by_cidr[row.cidr] = max(row.last_seen, newest_by_cidr.get(row.cidr, row.last_seen))
        origins: dict[str, DropNetworkOrigin] = {}
        for cidr, asn_counts in row_counts_by_asn.items():
            known_asns = {key: count for key, count in asn_counts.items() if key[0] is not None}
            asn, as_org = (
                min(known_asns, key=lambda key: (-known_asns[key], key[0] or 0)) if known_asns else (None, None)
            )
            origins[cidr] = DropNetworkOrigin(asn=asn, as_org=as_org, last_seen=newest_by_cidr[cidr])
        return origins


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True
