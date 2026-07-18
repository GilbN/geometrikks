"""Services for access log data."""
from __future__ import annotations

from datetime import datetime

from advanced_alchemy.filters import FilterTypes, LimitOffset
from advanced_alchemy.repository import SQLAlchemyAsyncRepository
from advanced_alchemy.service import SQLAlchemyAsyncRepositoryService
from litestar.exceptions import ValidationException
from sqlalchemy import func, select

from geometrikks.domain.logs.models import AccessLog, AccessLogDebug
from geometrikks.domain.logs.schemas import (
    AccessLogDebugEntry,
    AccessLogDebugStats,
    AccessLogFacets,
    CountryFacet,
    ParseErrorCount,
)


class AccessLogService(SQLAlchemyAsyncRepositoryService[AccessLog]):
    """Repository service for AccessLog, providing filtering and pagination."""

    class Repo(SQLAlchemyAsyncRepository[AccessLog]):
        model_type = AccessLog

    repository_type = Repo

    async def get_facets(self) -> AccessLogFacets:
        """Distinct country/city values present in the data, for filter dropdowns.

        Rows without geo data (NULL columns) are excluded; ``name`` falls back
        to the code when ``country_name`` is missing. Countries are deduped by
        code (a non-null name wins over NULL) and sorted by the displayed name.
        """
        session = self.repository.session
        country_name = func.max(AccessLog.country_name)
        country_rows = (
            await session.execute(
                select(AccessLog.country_code, country_name)
                .where(AccessLog.country_code.is_not(None))
                .group_by(AccessLog.country_code)
                .order_by(func.coalesce(country_name, AccessLog.country_code))
            )
        ).all()
        cities = (
            await session.execute(
                select(AccessLog.city)
                .where(AccessLog.city.is_not(None))
                .distinct()
                .order_by(AccessLog.city)
            )
        ).scalars().all()
        return AccessLogFacets(
            countries=[CountryFacet(code=code, name=name or code) for code, name in country_rows],
            cities=list(cities),
        )


# Sortable columns for the debug list; spans both sides of the LEFT JOIN,
# which is why sorting is not delegated to the standard OrderBy filter
# (it can only resolve fields on the base model).
DEBUG_SORT_COLUMNS = {
    "created_at": AccessLogDebug.created_at,
    "is_malformed": AccessLogDebug.is_malformed,
    "parse_error": AccessLogDebug.parse_error,
    "timestamp": AccessLog.timestamp,
    "status_code": AccessLog.status_code,
    "ip_address": AccessLog.ip_address,
    "host": AccessLog.host,
    "country_code": AccessLog.country_code,
    "city": AccessLog.city,
}


class AccessLogDebugService(SQLAlchemyAsyncRepositoryService[AccessLogDebug]):
    """Repository service for AccessLogDebug with joined access-log context."""

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
        """Debug rows LEFT JOINed to access_logs, with filtering and paging.

        Standard advanced-alchemy filters (time window on ``created_at``,
        search over ``raw_line``/``parse_error``, LimitOffset) apply to the
        debug table. ip/country/city match the JOINed access_logs columns, so
        rows without a linked access log drop out when those are set.

        Raises:
            ValidationException: On an order_by field outside the allowlist
                or a sort_order other than asc/desc.
        """
        sort_col = DEBUG_SORT_COLUMNS.get(order_by)
        if sort_col is None:
            raise ValidationException(detail=f"Cannot sort by {order_by!r}")
        if sort_order not in ("asc", "desc"):
            raise ValidationException(detail=f"Invalid sort order {sort_order!r}")

        stmt = select(
            AccessLogDebug.id,
            AccessLogDebug.access_log_id,
            AccessLogDebug.created_at,
            AccessLogDebug.raw_line,
            AccessLogDebug.is_malformed,
            AccessLogDebug.parse_error,
            AccessLog.timestamp,
            AccessLog.ip_address,
            AccessLog.method,
            AccessLog.url,
            AccessLog.host,
            AccessLog.status_code,
            AccessLog.country_code,
            AccessLog.country_name,
            AccessLog.city,
            AccessLog.user_agent,
        ).outerjoin(AccessLog, AccessLogDebug.access_log_id == AccessLog.id)

        if ip_addresses:
            stmt = stmt.where(AccessLog.ip_address.in_(ip_addresses))
        if country_codes:
            stmt = stmt.where(AccessLog.country_code.in_(country_codes))
        if cities:
            stmt = stmt.where(AccessLog.city.in_(cities))
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
        # nulls_last so unlinked rows (NULL joined columns) sink on both
        # directions; id tiebreak keeps paging stable within one created_at.
        stmt = stmt.order_by(direction.nulls_last(), AccessLogDebug.id.desc())
        if limit_offset is not None:
            stmt = limit_offset.append_to_statement(stmt, AccessLogDebug)

        rows = (await session.execute(stmt)).all()
        return [
            AccessLogDebugEntry(
                id=row.id,
                access_log_id=row.access_log_id,
                created_at=row.created_at,
                raw_line=row.raw_line,
                is_malformed=row.is_malformed,
                parse_error=row.parse_error,
                timestamp=row.timestamp,
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

        return AccessLogDebugStats(
            total=total,
            malformed=malformed,
            top_parse_error=(
                ParseErrorCount(error=top.parse_error, count=top.error_count)
                if top is not None
                else None
            ),
        )
