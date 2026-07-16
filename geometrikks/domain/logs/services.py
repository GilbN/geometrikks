"""Services for access log data."""
from __future__ import annotations

from advanced_alchemy.repository import SQLAlchemyAsyncRepository
from advanced_alchemy.service import SQLAlchemyAsyncRepositoryService
from sqlalchemy import select

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
        to the code when ``country_name`` is missing.
        """
        session = self.repository.session
        country_rows = (
            await session.execute(
                select(AccessLog.country_code, AccessLog.country_name)
                .where(AccessLog.country_code.is_not(None))
                .distinct()
                .order_by(AccessLog.country_name)
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
