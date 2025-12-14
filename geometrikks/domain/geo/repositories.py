"""Repositories for geo-location and geo-event data access."""
from __future__ import annotations

from advanced_alchemy.repository import SQLAlchemyAsyncRepository

from geometrikks.domain.geo.models import GeoLocation, GeoEvent


class GeoLocationRepository(SQLAlchemyAsyncRepository[GeoLocation]):
    """Repository for GeoLocation model."""

    model_type = GeoLocation

    async def get_by_geohash(self, geohash: str) -> GeoLocation | None:
        """Find a GeoLocation by its geohash.

        Args:
            geohash: The geohash string to search for.

        Returns:
            GeoLocation if found, None otherwise.
        """
        return await self.get_one_or_none(geohash=geohash)

    async def get_by_country_code(self, country_code: str) -> list[GeoLocation]:
        """Retrieve all GeoLocations for a given country code.

        Args:
            country_code: ISO 3166-1 alpha-2 country code (e.g., 'US', 'DE').

        Returns:
            List of GeoLocation instances matching the country code.
        """
        return await self.list(country_code=country_code)


class GeoEventRepository(SQLAlchemyAsyncRepository[GeoEvent]):
    """Repository for GeoEvent model."""

    model_type = GeoEvent
    
    