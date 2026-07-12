"""GeoLocation API endpoints."""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Annotated
import logging

from advanced_alchemy.extensions.litestar import filters
from litestar.pagination import OffsetPagination
from litestar import Controller, get
from litestar.di import NamedDependency, Provide
from litestar.params import Parameter, PathParameter
from litestar.openapi.spec import Example

from geometrikks.domain.geo.models import GeoLocation
from geometrikks.domain.geo.repositories import GeoLocationRepository
from geometrikks.domain.geo.dtos import (
    GeoLocationDTO,
    EmbeddedLocationDTO,
    GeoJSONFeatureCollection,
    GeoJSONFeature,
    GeoJSONPointGeometry,
    GeoJSONFeatureProperties,
    GeoJSONFeatureStats,
    TopIPDTO,
    LocationTopIPsResponse,
    GlobalTopIPsResponse,
    TopCountryDTO,
    TopCountriesResponse,
)

from geometrikks.api.dependencies import provide_geo_location_repo

logger = logging.getLogger(__name__)

class GeoLocationController(Controller):
    """Geo-location endpoints for managing location data."""

    path = "/api/v1/geo-locations"
    tags = ["Geo Locations"]
    return_dto = GeoLocationDTO

    dependencies = {
        "geo_location_repo": Provide(provide_geo_location_repo),
    }

    @get("/")
    async def list_geo_locations(
        self,
        geo_location_repo: NamedDependency[GeoLocationRepository],
        limit_offset: NamedDependency[filters.LimitOffset],
    ) -> OffsetPagination[GeoLocation]:
        """List all geo-locations with pagination."""
        results, total = await geo_location_repo.list_and_count(limit_offset)
        return OffsetPagination[GeoLocation](
            items=results,
            total=total,
            limit=limit_offset.limit,
            offset=limit_offset.offset,
        )

    @get("/geojson", return_dto=None, description="Get all locations with event counts as GeoJSON FeatureCollection.")
    async def get_geojson(
        self,
        geo_location_repo: NamedDependency[GeoLocationRepository],
        from_timestamp: Annotated[
            datetime,
            Parameter(
                description="Start datetime (ISO 8601 with timezone, e.g., 2024-01-01T00:00:00Z)",
                examples=[Example(value="2024-01-01T00:00:00Z")],
            ),
        ],
        to_timestamp: Annotated[
            datetime,
            Parameter(
                description="End datetime (ISO 8601 with timezone, e.g., 2024-12-31T23:59:59Z)",
                examples=[Example(value="2024-12-31T23:59:59Z")],
            ),
        ],
        country_code: Annotated[
            list[str] | None,
            Parameter(description="Filter to these ISO country codes (repeatable)", required=False),
        ] = None,
        city: Annotated[
            list[str] | None,
            Parameter(description="Filter to these city names (repeatable)", required=False),
        ] = None,
    ) -> GeoJSONFeatureCollection:
        """Get all locations with event counts as GeoJSON FeatureCollection.

        Returns a GeoJSON FeatureCollection where each feature represents a
        location with its coordinates and properties including the event count.
        Args:
            from_datetime: Start datetime for filtering events.
            to_datetime: End datetime for filtering events.
        Returns:
            GeoJSONFeatureCollection containing locations and their event counts.
        """
        # Ensure timezone awareness if datetimes are provided
        if from_timestamp is not None and from_timestamp.tzinfo is None:
            from_timestamp = from_timestamp.replace(tzinfo=timezone.utc)
        if to_timestamp is not None and to_timestamp.tzinfo is None:
            to_timestamp = to_timestamp.replace(tzinfo=timezone.utc)

        locations_with_counts = await geo_location_repo.get_all_with_event_counts(
            from_timestamp, to_timestamp, country_codes=country_code, cities=city
        )
        
        events: int = sum(loc.event_count for loc in locations_with_counts)
        countries: int = len({loc.location.country_code for loc in locations_with_counts if loc.location.country_code})
        cities: int = len({loc.location.city for loc in locations_with_counts if loc.location.city})
        unique_locations: int = len(locations_with_counts)

        stats = GeoJSONFeatureStats(
            events=events,
            countries=countries,
            cities=cities,
            locations=unique_locations,
        )
        features = [
            GeoJSONFeature(
                type="Feature",
                geometry=GeoJSONPointGeometry(
                    type="Point",
                    coordinates=(loc.location.longitude, loc.location.latitude),
                ),
                properties=GeoJSONFeatureProperties(
                    id=loc.location.id,
                    geohash=loc.location.geohash,
                    country_code=loc.location.country_code,
                    country_name=loc.location.country_name,
                    state=loc.location.state,
                    state_code=loc.location.state_code,
                    city=loc.location.city,
                    postal_code=loc.location.postal_code,
                    timezone=loc.location.timezone,
                    event_count=loc.event_count,
                    last_hit=loc.location.last_hit,
                ),
            )
            for loc in locations_with_counts
        ]
        return GeoJSONFeatureCollection(type="FeatureCollection", features=features, stats=stats)

    @get("/top-ips", return_dto=None, description="Get global top IPs by event count with their primary locations.")
    async def get_global_top_ips(
        self,
        geo_location_repo: NamedDependency[GeoLocationRepository],
        from_timestamp: Annotated[
            datetime,
            Parameter(
                description="Start datetime (ISO 8601 with timezone, e.g., 2024-01-01T00:00:00Z)",
                examples=[Example(value="2024-01-01T00:00:00Z")],
            ),
        ],
        to_timestamp: Annotated[
            datetime,
            Parameter(
                description="End datetime (ISO 8601 with timezone, e.g., 2024-12-31T23:59:59Z)",
                examples=[Example(value="2024-12-31T23:59:59Z")],
            ),
        ],
        limit: Annotated[
            int,
            Parameter(description="Maximum number of IPs to return", ge=1, le=20),
        ] = 5,
    ) -> GlobalTopIPsResponse:
        """Get global top IPs by event count with their primary locations.

        Returns the top N IPs globally with the highest event counts,
        along with the location where each IP has the most events.
        """
        if from_timestamp is not None and from_timestamp.tzinfo is None:
            from_timestamp = from_timestamp.replace(tzinfo=timezone.utc)
        if to_timestamp is not None and to_timestamp.tzinfo is None:
            to_timestamp = to_timestamp.replace(tzinfo=timezone.utc)

        global_top_ips_data = await geo_location_repo.get_global_top_ips(
            from_timestamp, to_timestamp, limit=limit
        )
        top_ips = [
            TopIPDTO(
                ip_address=ip,
                event_count=count,
                location=EmbeddedLocationDTO(
                    id=loc.id,
                    latitude=loc.latitude,
                    longitude=loc.longitude,
                    city=loc.city,
                    country_code=loc.country_code,
                    country_name=loc.country_name,
                ),
            )
            for ip, count, loc in global_top_ips_data
        ]
        return GlobalTopIPsResponse(top_ips=top_ips)

    @get("/{location_id:int}/top-ips", return_dto=None, description="Get top IPs for a specific location.")
    async def get_location_top_ips(
        self,
        geo_location_repo: NamedDependency[GeoLocationRepository],
        location_id: Annotated[int, PathParameter()],
        from_timestamp: Annotated[
            datetime,
            Parameter(
                description="Start datetime (ISO 8601 with timezone, e.g., 2024-01-01T00:00:00Z)",
                examples=[Example(value="2024-01-01T00:00:00Z")],
            ),
        ],
        to_timestamp: Annotated[
            datetime,
            Parameter(
                description="End datetime (ISO 8601 with timezone, e.g., 2024-12-31T23:59:59Z)",
                examples=[Example(value="2024-12-31T23:59:59Z")],
            ),
        ],
        limit: Annotated[
            int,
            Parameter(description="Maximum number of IPs to return", ge=1, le=20),
        ] = 5,
    ) -> LocationTopIPsResponse:
        """Get top IPs for a specific location.

        Returns the top N IPs with the highest event counts for the given location.
        """
        if from_timestamp is not None and from_timestamp.tzinfo is None:
            from_timestamp = from_timestamp.replace(tzinfo=timezone.utc)
        if to_timestamp is not None and to_timestamp.tzinfo is None:
            to_timestamp = to_timestamp.replace(tzinfo=timezone.utc)

        top_ips_data = await geo_location_repo.get_location_top_ips(
            location_id, from_timestamp, to_timestamp, limit=limit
        )
        top_ips = [
            TopIPDTO(ip_address=ip.ip_address, event_count=ip.event_count)
            for ip in top_ips_data
        ]
        return LocationTopIPsResponse(location_id=location_id, top_ips=top_ips)

    @get("/top-countries", return_dto=None, description="Get top countries by event count.")
    async def get_top_countries(
        self,
        geo_location_repo: NamedDependency[GeoLocationRepository],
        from_timestamp: Annotated[
            datetime,
            Parameter(
                description="Start datetime (ISO 8601 with timezone, e.g., 2024-01-01T00:00:00Z)",
                examples=[Example(value="2024-01-01T00:00:00Z")],
            ),
        ],
        to_timestamp: Annotated[
            datetime,
            Parameter(
                description="End datetime (ISO 8601 with timezone, e.g., 2024-12-31T23:59:59Z)",
                examples=[Example(value="2024-12-31T23:59:59Z")],
            ),
        ],
        limit: Annotated[
            int,
            Parameter(description="Maximum number of countries to return", ge=1, le=50),
        ] = 10,
    ) -> TopCountriesResponse:
        """Get top countries by event count.

        Returns the top N countries with the highest event counts.
        """
        if from_timestamp is not None and from_timestamp.tzinfo is None:
            from_timestamp = from_timestamp.replace(tzinfo=timezone.utc)
        if to_timestamp is not None and to_timestamp.tzinfo is None:
            to_timestamp = to_timestamp.replace(tzinfo=timezone.utc)

        top_countries_data = await geo_location_repo.get_top_countries(
            from_timestamp, to_timestamp, limit=limit
        )
        top_countries = [
            TopCountryDTO(
                country_code=country_code,
                country_name=country_name,
                event_count=event_count,
            )
            for country_code, country_name, event_count in top_countries_data
        ]
        return TopCountriesResponse(top_countries=top_countries)