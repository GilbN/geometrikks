"""Services for access log data."""
from __future__ import annotations

from datetime import datetime

from advanced_alchemy.filters import FilterTypes, LimitOffset
from advanced_alchemy.repository import SQLAlchemyAsyncRepository
from advanced_alchemy.service import SQLAlchemyAsyncRepositoryService
from sqlalchemy import func, select, text

from geometrikks.domain.exceptions import DomainValidationError

from geometrikks.domain.logs.models import AccessLog, AccessLogDebug
from geometrikks.domain.logs.schemas import (
    AccessLogDebugEntry,
    AccessLogDebugStats,
    AccessLogFacets,
    CountryFacet,
    ParseErrorCount,
)
from geometrikks.server.logging import get_logger

logger = get_logger(__name__)


class AccessLogService(SQLAlchemyAsyncRepositoryService[AccessLog]):
    """Repository service for AccessLog, providing filtering and pagination."""

    class Repo(SQLAlchemyAsyncRepository[AccessLog]):
        model_type = AccessLog

    repository_type = Repo
    # Two queries (page + count(*)) instead of one with count(*) OVER ().
    # The window function forces every row in the filter window through the
    # sort before LIMIT applies: on the compressed hypertable that
    # decompresses all matching chunks (~15s over 365d / 17M rows), while the
    # split queries run in milliseconds. Timescale answers the bare count(*)
    # from compressed-batch metadata without decompressing. Must live on the
    # service, not the Repo: the service ClassVar is passed to the repository
    # constructor and overrides any repository-level attribute.
    count_with_window_function = False

    async def get_facets(self) -> AccessLogFacets:
        """Distinct country/city/host values present in the data, for filter dropdowns.

        Countries and cities come from log_ip_daily_stats and hosts from
        host_daily_stats (both real-time aggregated), not the raw hypertable:
        the facet query cost then scales with distinct values per day instead
        of total log volume. Values persist beyond raw retention (daily CAGGs
        keep history), which is the desired behavior for filter dropdowns.

        Rows without geo data (NULL columns) are excluded; ``name`` falls back
        to the code when ``country_name`` is missing. Countries are deduped by
        code (a non-null name wins over NULL) and sorted by the displayed name.
        """
        session = self.repository.session
        country_rows = (
            await session.execute(text(
                "SELECT country_code, MAX(country_name) AS name "
                "FROM log_ip_daily_stats "
                "WHERE country_code IS NOT NULL "
                "GROUP BY country_code "
                "ORDER BY COALESCE(MAX(country_name), country_code)"
            ))
        ).all()
        cities = (
            await session.execute(text(
                "SELECT DISTINCT city FROM log_ip_daily_stats "
                "WHERE city IS NOT NULL ORDER BY city"
            ))
        ).scalars().all()
        hosts = (
            await session.execute(text(
                "SELECT DISTINCT host FROM host_daily_stats ORDER BY host"
            ))
        ).scalars().all()
        return AccessLogFacets(
            countries=[CountryFacet(code=code, name=name or code) for code, name in country_rows],
            cities=list(cities),
            hosts=list(hosts),
        )


# Sortable columns for the debug list. All of them live on AccessLogDebug:
# sorting happens before pagination, so a sort key on another table would drag
# the whole access_logs hypertable back into the query. Sorting is not
# delegated to the standard OrderBy filter because the logical "timestamp" key
# maps to the log_timestamp column, which that filter cannot resolve.
DEBUG_SORT_COLUMNS = {
    "created_at": AccessLogDebug.created_at,
    "is_malformed": AccessLogDebug.is_malformed,
    "parse_error": AccessLogDebug.parse_error,
    "timestamp": AccessLogDebug.log_timestamp,
    "status_code": AccessLogDebug.status_code,
    "ip_address": AccessLogDebug.ip_address,
    "host": AccessLogDebug.host,
    "country_code": AccessLogDebug.country_code,
    "city": AccessLogDebug.city,
}


class AccessLogDebugService(SQLAlchemyAsyncRepositoryService[AccessLogDebug]):
    """Repository service for AccessLogDebug with denormalized log context."""

    class Repo(SQLAlchemyAsyncRepository[AccessLogDebug]):
        model_type = AccessLogDebug

    repository_type = Repo

    async def list_entries(
        self,
        *filters: FilterTypes,
        ip_addresses: list[str] | None = None,
        country_codes: list[str] | None = None,
        cities: list[str] | None = None,
        malformed: bool | None = None,
        order_by: str = "created_at",
        sort_order: str = "desc",
    ) -> tuple[list[AccessLogDebugEntry], int]:
        """Debug rows with their denormalized access-log context.

        Every column this filters, sorts or returns lives on access_log_debug
        itself, copied from the linked access_logs row at ingestion. Nothing
        here touches the access_logs hypertable. ip/country/city still drop
        rows that never linked to an access log, since those columns are NULL
        for unlinked rows.

        Standard advanced-alchemy filters (time window on ``created_at``,
        search over ``raw_line``/``parse_error``, LimitOffset) apply as before.

        Raises:
            DomainValidationError: On an order_by field outside the allowlist
                or a sort_order other than asc/desc.
        """
        sort_col = DEBUG_SORT_COLUMNS.get(order_by)
        if sort_col is None:
            raise DomainValidationError(f"Cannot sort by {order_by!r}")
        if sort_order not in ("asc", "desc"):
            raise DomainValidationError(f"Invalid sort order {sort_order!r}")

        stmt = select(
            AccessLogDebug.id,
            AccessLogDebug.access_log_id,
            AccessLogDebug.created_at,
            AccessLogDebug.raw_line,
            AccessLogDebug.is_malformed,
            AccessLogDebug.parse_error,
            AccessLogDebug.log_timestamp,
            AccessLogDebug.ip_address,
            AccessLogDebug.method,
            AccessLogDebug.url,
            AccessLogDebug.host,
            AccessLogDebug.status_code,
            AccessLogDebug.country_code,
            AccessLogDebug.country_name,
            AccessLogDebug.city,
            AccessLogDebug.user_agent,
        )

        if ip_addresses:
            stmt = stmt.where(AccessLogDebug.ip_address.in_(ip_addresses))
        if country_codes:
            stmt = stmt.where(AccessLogDebug.country_code.in_(country_codes))
        if cities:
            stmt = stmt.where(AccessLogDebug.city.in_(cities))
        if malformed is not None:
            stmt = stmt.where(AccessLogDebug.is_malformed == malformed)

        limit_offset: LimitOffset | None = None
        for f in filters:
            if isinstance(f, LimitOffset):
                limit_offset = f
            else:
                stmt = f.append_to_statement(stmt, AccessLogDebug)

        session = self.repository.session
        total = (
            await session.execute(select(func.count()).select_from(stmt.subquery()))
        ).scalar_one()

        direction = sort_col.desc() if sort_order == "desc" else sort_col.asc()
        # nulls_last so unlinked rows (NULL context columns) sink on both
        # directions; id tiebreak keeps paging stable within one created_at.
        stmt = stmt.order_by(direction.nulls_last(), AccessLogDebug.id.desc())
        if limit_offset is not None:
            stmt = limit_offset.append_to_statement(stmt, AccessLogDebug)

        rows = (await session.execute(stmt)).all()
        logger.debug("access_log_debug_page_fetched", rows=len(rows), total=total)
        return [
            AccessLogDebugEntry(
                id=row.id,
                access_log_id=row.access_log_id,
                created_at=row.created_at,
                raw_line=row.raw_line,
                is_malformed=row.is_malformed,
                parse_error=row.parse_error,
                timestamp=row.log_timestamp,
                # INET comes back as an ipaddress object, not str
                ip_address=str(row.ip_address) if row.ip_address is not None else None,
                method=row.method,
                url=row.url,
                host=row.host,
                status_code=row.status_code,
                country_code=row.country_code,
                country_name=row.country_name,
                city=row.city,
                user_agent=row.user_agent,
            )
            for row in rows
        ], total

    async def get_stats(
        self,
        on_or_after: datetime | None = None,
        on_or_before: datetime | None = None,
    ) -> AccessLogDebugStats:
        """Aggregates for the stat cards, scoped to the created_at range only.

        Deliberately ignores the list filters: the cards summarize the whole
        window while the table narrows within it.
        """
        session = self.repository.session
        conditions = []
        if on_or_after is not None:
            conditions.append(AccessLogDebug.created_at >= on_or_after)
        if on_or_before is not None:
            conditions.append(AccessLogDebug.created_at <= on_or_before)

        total, malformed = (
            await session.execute(
                select(
                    func.count(),
                    func.count().filter(AccessLogDebug.is_malformed.is_(True)),
                )
                .select_from(AccessLogDebug)
                .where(*conditions)
            )
        ).one()

        top = (
            await session.execute(
                select(AccessLogDebug.parse_error, func.count().label("error_count"))
                .where(AccessLogDebug.parse_error.is_not(None), *conditions)
                .group_by(AccessLogDebug.parse_error)
                .order_by(func.count().desc(), AccessLogDebug.parse_error)
                .limit(1)
            )
        ).first()

        logger.debug("access_log_debug_stats_fetched", total=total, malformed=malformed)
        return AccessLogDebugStats(
            total=total,
            malformed=malformed,
            top_parse_error=(
                ParseErrorCount(error=top.parse_error, count=top.error_count)
                if top is not None
                else None
            ),
        )
