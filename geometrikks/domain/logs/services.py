"""Services for access log data."""
from __future__ import annotations

from advanced_alchemy.repository import SQLAlchemyAsyncRepository
from advanced_alchemy.service import SQLAlchemyAsyncRepositoryService
from sqlalchemy import func, select

from geometrikks.domain.logs.models import AccessLog
from geometrikks.domain.logs.schemas import AccessLogFacets, CountryFacet


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
