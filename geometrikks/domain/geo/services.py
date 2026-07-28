"""Services for geo-event data (geo-logs page aggregates).

Query routing follows the repository convention:
- RAW geo_events for ranges ≤ 24h, and whenever a hostname filter is set
  (no CAGG carries a hostname dimension).
- ip_location_{hourly,daily}_stats for grouped/top-IP queries and for
  country/city/IP-filtered summary/time-series queries on longer ranges
  (keyed by location + IP, so those filters still apply there).
  Whole buckets come from the CAGG and the partial head/tail from raw
  geo_events, so these stay exact against a raw scan of the same window.
- geo_summary_{hourly,daily}_stats (HLL uniques) for unfiltered summary and
  time-series queries on longer ranges.
"""
from __future__ import annotations

from datetime import datetime

from advanced_alchemy.repository import SQLAlchemyAsyncRepository
from advanced_alchemy.service import SQLAlchemyAsyncRepositoryService
from sqlalchemy import func, select, text

from geometrikks.domain.geo.models import GeoEvent, GeoLocation
from geometrikks.domain.geo.repositories import StatsGranularity, get_stats_granularity, stitched_ip_location_cte
from geometrikks.domain.geo.schemas import (
    GeoCountryFacet,
    GeoEventFacets,
    GeoEventFilters,
    GeoLogEntry,
    GeoLogPeriod,
    GeoLogTimeSeriesPoint,
    TopGeoCity,
    TopGeoCountry,
    TopGeoIp,
)
from geometrikks.server.logging import get_logger

logger = get_logger(__name__)


class GeoEventService(SQLAlchemyAsyncRepositoryService[GeoEvent]):
    """Repository service for GeoEvent: list/pagination plus geo-logs aggregates."""

    class Repo(SQLAlchemyAsyncRepository[GeoEvent]):
        model_type = GeoEvent

    repository_type = Repo

    @property
    def _session(self):
        return self.repository.session

    async def get_grouped_logs(
        self,
        start: datetime,
        end: datetime,
        filters: GeoEventFilters,
        *,
        limit: int,
        offset: int,
        sort_order: str = "desc",
    ) -> tuple[list[GeoLogEntry], int]:
        """Rows grouped by (location, IP) with counts, plus the total group count.

        Raw path (≤ 24h or hostname filter): exact counts, last event time and
        distinct hostnames. CAGG path: per-IP CAGG sums stitched with the raw
        edge buckets — exact counts, bucket-granular last_seen, no hostnames.
        """
        if sort_order not in ("asc", "desc"):
            raise ValueError("sort_order must be 'asc' or 'desc'")
        granularity = get_stats_granularity(start, end)
        use_raw = granularity == StatsGranularity.RAW or filters.forces_raw

        location_cols = (
            "gl.id AS location_id, gl.city, gl.postal_code, gl.state, gl.state_code, "
            "gl.country_code, gl.country_name, gl.latitude, gl.longitude"
        )
        if use_raw:
            filter_sql, filter_params = filters.sql_conditions("ge", "gl")
            source = f"""
                SELECT
                    {location_cols},
                    host(ge.ip_address) AS ip_address,
                    CAST(COUNT(*) AS BIGINT) AS event_count,
                    MAX(ge.timestamp) AS last_seen,
                    array_agg(DISTINCT ge.hostname) AS hostnames
                FROM geo_events ge
                JOIN geo_locations gl ON ge.location_id = gl.id
                WHERE ge.timestamp >= :start AND ge.timestamp < :end
                {filter_sql}
                GROUP BY gl.id, ge.ip_address
            """
            order_col = "ip_address"
        else:
            filter_sql, filter_params = filters.sql_conditions("c", "gl")
            source = f"""
                {stitched_ip_location_cte(granularity)}
                SELECT
                    {location_cols},
                    host(c.ip_address) AS ip_address,
                    CAST(SUM(c.event_count) AS BIGINT) AS event_count,
                    MAX(c.last_seen) AS last_seen,
                    NULL AS hostnames
                FROM combined c
                JOIN geo_locations gl ON c.location_id = gl.id
                WHERE TRUE
                {filter_sql}
                GROUP BY gl.id, c.ip_address
            """
            order_col = "ip_address"

        params = {"start": start, "end": end, **filter_params}
        stmt = text(
            f"SELECT * FROM ({source}) grouped "
            f"ORDER BY event_count {sort_order.upper()}, location_id, {order_col} "
            "LIMIT :limit OFFSET :offset"
        )
        result = await self._session.execute(stmt, {**params, "limit": limit, "offset": offset})
        rows = result.fetchall()

        count_stmt = text(f"SELECT COUNT(*) FROM ({source}) grouped")
        total = (await self._session.execute(count_stmt, params)).scalar_one()

        return [
            GeoLogEntry(
                location_id=row.location_id,
                city=row.city,
                postal_code=row.postal_code,
                state=row.state,
                state_code=row.state_code,
                country_code=row.country_code,
                country_name=row.country_name,
                ip_address=row.ip_address,
                latitude=row.latitude,
                longitude=row.longitude,
                event_count=row.event_count,
                last_seen=row.last_seen,
                hostnames=sorted(row.hostnames) if row.hostnames else [],
            )
            for row in rows
        ], total

    async def get_summary(
        self, start: datetime, end: datetime, filters: GeoEventFilters
    ) -> GeoLogPeriod:
        """Aggregate totals/uniques for the period.

        Hostname filters (or <= 24h ranges) scan raw geo_events; country/city/IP
        filters use the stitched per-IP CAGGs with exact uniques; unfiltered
        longer ranges use the HLL geo_summary CAGGs.
        """
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW or filters.forces_raw:
            filter_sql, filter_params = filters.sql_conditions("ge", "gl")
            stmt = text(f"""
                SELECT
                    CAST(COUNT(*) AS BIGINT) AS total_events,
                    CAST(COUNT(DISTINCT ge.ip_address) AS BIGINT) AS unique_ips,
                    CAST(COUNT(DISTINCT gl.country_code) AS BIGINT) AS unique_countries,
                    CAST(COUNT(DISTINCT gl.city) AS BIGINT) AS unique_cities
                FROM geo_events ge
                JOIN geo_locations gl ON ge.location_id = gl.id
                WHERE ge.timestamp >= :start AND ge.timestamp < :end
                {filter_sql}
            """)
            params = {"start": start, "end": end, **filter_params}
        elif filters.is_active():
            # Country/city/IP filters: stitched per-IP CAGG read joined to
            # geo_locations. Keyed by IP, so every unique count is exact.
            filter_sql, filter_params = filters.sql_conditions("c", "gl")
            stmt = text(f"""
                {stitched_ip_location_cte(granularity)}
                SELECT
                    CAST(COALESCE(SUM(c.event_count), 0) AS BIGINT) AS total_events,
                    CAST(COUNT(DISTINCT c.ip_address) AS BIGINT) AS unique_ips,
                    CAST(COUNT(DISTINCT gl.country_code) AS BIGINT) AS unique_countries,
                    CAST(COUNT(DISTINCT gl.city) AS BIGINT) AS unique_cities
                FROM combined c
                JOIN geo_locations gl ON c.location_id = gl.id
                WHERE TRUE
                {filter_sql}
            """)
            params = {"start": start, "end": end, **filter_params}
        else:
            table = f"geo_summary_{granularity.value}_stats"
            interval = "1 hour" if granularity == StatsGranularity.HOURLY else "1 day"
            stmt = text(f"""
                SELECT
                    CAST(COALESCE(SUM(total_events), 0) AS BIGINT) AS total_events,
                    CAST(COALESCE(distinct_count(rollup(hll_ips)), 0) AS BIGINT) AS unique_ips,
                    CAST(COALESCE(distinct_count(rollup(hll_countries)), 0) AS BIGINT) AS unique_countries,
                    CAST(COALESCE(distinct_count(rollup(hll_cities)), 0) AS BIGINT) AS unique_cities
                FROM {table}
                WHERE bucket >= time_bucket('{interval}', CAST(:start AS timestamptz))
                  AND bucket < :end
            """)
            params = {"start": start, "end": end}

        row = (await self._session.execute(stmt, params)).one()
        return GeoLogPeriod(
            total_events=row.total_events,
            unique_ips=row.unique_ips,
            unique_countries=row.unique_countries,
            unique_cities=row.unique_cities,
        )

    async def get_time_series(
        self,
        start: datetime,
        end: datetime,
        granularity: StatsGranularity,
        filters: GeoEventFilters,
    ) -> list[GeoLogTimeSeriesPoint]:
        """Bucketed event totals + unique IPs for the chart.

        ``granularity`` must be HOURLY or DAILY (the controller clamps RAW to
        HOURLY, matching the analytics charts) and only picks the bucket size;
        routing is decided separately from the actual ``start``/``end`` span.
        Hostname filters and <= 24h windows scan raw geo_events. An hourly-
        bucket override on a > 30d window (``granularity`` HOURLY while the
        window itself is DAILY-routed) also scans raw when any filter is
        active, since hourly CAGG retention doesn't cover ranges that long
        and the stitched per-IP CAGGs only carry the daily rollup there.
        Other country/city/IP-filtered ranges use the stitched per-IP CAGGs;
        unfiltered ranges > 24h use the HLL geo_summary CAGGs.
        """
        if granularity not in (StatsGranularity.HOURLY, StatsGranularity.DAILY):
            raise ValueError("granularity must be HOURLY or DAILY")
        interval = "1 hour" if granularity == StatsGranularity.HOURLY else "1 day"
        # Routing (raw vs CAGG) tracks the actual span, independent of the
        # requested bucket size above: a <= 24h span must stay on raw even
        # when the caller asks for hourly buckets on it.
        data_granularity = get_stats_granularity(start, end)

        if (
            filters.forces_raw
            or data_granularity == StatsGranularity.RAW
            or (
                filters.is_active()
                and granularity == StatsGranularity.HOURLY
                and data_granularity == StatsGranularity.DAILY
            )
        ):
            filter_sql, filter_params = filters.sql_conditions("ge", "gl")
            stmt = text(f"""
                SELECT
                    time_bucket('{interval}', ge.timestamp) AS bucket,
                    CAST(COUNT(*) AS BIGINT) AS total_events,
                    CAST(COUNT(DISTINCT ge.ip_address) AS BIGINT) AS unique_ips
                FROM geo_events ge
                JOIN geo_locations gl ON ge.location_id = gl.id
                WHERE ge.timestamp >= :start AND ge.timestamp < :end
                {filter_sql}
                GROUP BY bucket
                ORDER BY bucket ASC
            """)
            params = {"start": start, "end": end, **filter_params}
        elif filters.is_active():
            # Country/city/IP filters: stitched per-IP CAGG rows re-bucketed.
            # CAGG-leg rows carry last_seen = bucket; raw edge rows carry the
            # exact timestamp, so partial head/tail buckets fold correctly.
            filter_sql, filter_params = filters.sql_conditions("c", "gl")
            stmt = text(f"""
                {stitched_ip_location_cte(granularity)}
                SELECT
                    time_bucket('{interval}', c.last_seen) AS bucket,
                    CAST(SUM(c.event_count) AS BIGINT) AS total_events,
                    CAST(COUNT(DISTINCT c.ip_address) AS BIGINT) AS unique_ips
                FROM combined c
                JOIN geo_locations gl ON c.location_id = gl.id
                WHERE TRUE
                {filter_sql}
                GROUP BY bucket
                ORDER BY bucket ASC
            """)
            params = {"start": start, "end": end, **filter_params}
        else:
            table = f"geo_summary_{granularity.value}_stats"
            stmt = text(f"""
                SELECT
                    bucket,
                    CAST(total_events AS BIGINT) AS total_events,
                    CAST(distinct_count(hll_ips) AS BIGINT) AS unique_ips
                FROM {table}
                WHERE bucket >= time_bucket('{interval}', CAST(:start AS timestamptz))
                  AND bucket < :end
                ORDER BY bucket ASC
            """)
            params = {"start": start, "end": end}

        result = await self._session.execute(stmt, params)
        return [
            GeoLogTimeSeriesPoint(
                timestamp=row.bucket,
                total_events=row.total_events or 0,
                unique_ips=row.unique_ips or 0,
            )
            for row in result.fetchall()
        ]

    async def get_top_ips(
        self, start: datetime, end: datetime, filters: GeoEventFilters, *, limit: int = 10
    ) -> list[TopGeoIp]:
        """Top IPs by event count across all locations."""
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW or filters.forces_raw:
            filter_sql, filter_params = filters.sql_conditions("ge", "gl")
            stmt = text(f"""
                SELECT
                    host(ge.ip_address) AS ip_address,
                    CAST(COUNT(*) AS BIGINT) AS event_count,
                    MAX(gl.country_code) AS country_code,
                    MAX(gl.city) AS city
                FROM geo_events ge
                JOIN geo_locations gl ON ge.location_id = gl.id
                WHERE ge.timestamp >= :start AND ge.timestamp < :end
                {filter_sql}
                GROUP BY ge.ip_address
                ORDER BY event_count DESC
                LIMIT :limit
            """)
        else:
            filter_sql, filter_params = filters.sql_conditions("c", "gl")
            stmt = text(f"""
                {stitched_ip_location_cte(granularity)}
                SELECT
                    host(c.ip_address) AS ip_address,
                    CAST(SUM(c.event_count) AS BIGINT) AS event_count,
                    MAX(gl.country_code) AS country_code,
                    MAX(gl.city) AS city
                FROM combined c
                JOIN geo_locations gl ON c.location_id = gl.id
                WHERE TRUE
                {filter_sql}
                GROUP BY c.ip_address
                ORDER BY event_count DESC
                LIMIT :limit
            """)
        result = await self._session.execute(
            stmt, {"start": start, "end": end, "limit": limit, **filter_params}
        )
        return [
            TopGeoIp(
                ip_address=row.ip_address,
                event_count=row.event_count,
                country_code=row.country_code,
                city=row.city,
            )
            for row in result.fetchall()
        ]

    async def get_top_countries(
        self, start: datetime, end: datetime, filters: GeoEventFilters, *, limit: int = 10
    ) -> list[TopGeoCountry]:
        """Top countries by event count with exact unique-IP counts."""
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW or filters.forces_raw:
            filter_sql, filter_params = filters.sql_conditions("ge", "gl")
            stmt = text(f"""
                SELECT
                    gl.country_code,
                    MAX(gl.country_name) AS country_name,
                    CAST(COUNT(*) AS BIGINT) AS event_count,
                    CAST(COUNT(DISTINCT ge.ip_address) AS BIGINT) AS unique_ips
                FROM geo_events ge
                JOIN geo_locations gl ON ge.location_id = gl.id
                WHERE ge.timestamp >= :start AND ge.timestamp < :end
                {filter_sql}
                GROUP BY gl.country_code
                ORDER BY event_count DESC
                LIMIT :limit
            """)
        else:
            # The CAGG is keyed by IP, so COUNT(DISTINCT) stays exact here.
            filter_sql, filter_params = filters.sql_conditions("c", "gl")
            stmt = text(f"""
                {stitched_ip_location_cte(granularity)}
                SELECT
                    gl.country_code,
                    MAX(gl.country_name) AS country_name,
                    CAST(SUM(c.event_count) AS BIGINT) AS event_count,
                    CAST(COUNT(DISTINCT c.ip_address) AS BIGINT) AS unique_ips
                FROM combined c
                JOIN geo_locations gl ON c.location_id = gl.id
                WHERE TRUE
                {filter_sql}
                GROUP BY gl.country_code
                ORDER BY event_count DESC
                LIMIT :limit
            """)
        result = await self._session.execute(
            stmt, {"start": start, "end": end, "limit": limit, **filter_params}
        )
        return [
            TopGeoCountry(
                country_code=row.country_code,
                country_name=row.country_name,
                event_count=row.event_count,
                unique_ips=row.unique_ips,
            )
            for row in result.fetchall()
        ]

    async def get_top_cities(
        self, start: datetime, end: datetime, filters: GeoEventFilters, *, limit: int = 10
    ) -> list[TopGeoCity]:
        """Top cities by event count (NULL cities excluded)."""
        granularity = get_stats_granularity(start, end)
        if granularity == StatsGranularity.RAW or filters.forces_raw:
            filter_sql, filter_params = filters.sql_conditions("ge", "gl")
            stmt = text(f"""
                SELECT
                    gl.city,
                    MAX(gl.country_code) AS country_code,
                    CAST(COUNT(*) AS BIGINT) AS event_count,
                    CAST(COUNT(DISTINCT ge.ip_address) AS BIGINT) AS unique_ips
                FROM geo_events ge
                JOIN geo_locations gl ON ge.location_id = gl.id
                WHERE ge.timestamp >= :start AND ge.timestamp < :end
                  AND gl.city IS NOT NULL
                {filter_sql}
                GROUP BY gl.city
                ORDER BY event_count DESC
                LIMIT :limit
            """)
        else:
            filter_sql, filter_params = filters.sql_conditions("c", "gl")
            stmt = text(f"""
                {stitched_ip_location_cte(granularity)}
                SELECT
                    gl.city,
                    MAX(gl.country_code) AS country_code,
                    CAST(SUM(c.event_count) AS BIGINT) AS event_count,
                    CAST(COUNT(DISTINCT c.ip_address) AS BIGINT) AS unique_ips
                FROM combined c
                JOIN geo_locations gl ON c.location_id = gl.id
                WHERE gl.city IS NOT NULL
                {filter_sql}
                GROUP BY gl.city
                ORDER BY event_count DESC
                LIMIT :limit
            """)
        result = await self._session.execute(
            stmt, {"start": start, "end": end, "limit": limit, **filter_params}
        )
        return [
            TopGeoCity(
                city=row.city,
                country_code=row.country_code,
                event_count=row.event_count,
                unique_ips=row.unique_ips,
            )
            for row in result.fetchall()
        ]

    async def get_facets(self) -> GeoEventFacets:
        """Distinct country/city/hostname values, for filter dropdowns.

        Countries are deduped by code (a non-null name wins) and sorted by
        the displayed name, mirroring AccessLogService.get_facets.
        """
        session = self._session
        country_name = func.max(GeoLocation.country_name)
        country_rows = (
            await session.execute(
                select(GeoLocation.country_code, country_name)
                .group_by(GeoLocation.country_code)
                .order_by(func.coalesce(country_name, GeoLocation.country_code))
            )
        ).all()
        cities = (
            await session.execute(
                select(GeoLocation.city)
                .where(GeoLocation.city.is_not(None))
                .distinct()
                .order_by(GeoLocation.city)
            )
        ).scalars().all()
        hostnames = (
            await session.execute(
                select(GeoEvent.hostname).distinct().order_by(GeoEvent.hostname)
            )
        ).scalars().all()
        return GeoEventFacets(
            countries=[GeoCountryFacet(code=code, name=name or code) for code, name in country_rows],
            cities=list(cities),
            hostnames=list(hostnames),
        )
