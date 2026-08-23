"""GeoLocation API endpoints."""
from __future__ import annotations
from typing import Annotated, Literal, cast

from advanced_alchemy.extensions.litestar.providers import create_service_dependencies
from advanced_alchemy.filters import FilterTypes
from advanced_alchemy.service import OffsetPagination
from litestar import Controller, Request, delete, get
from litestar.di import NamedDependency
from litestar.params import PathParameter, QueryParameter, SkipValidation
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.config.settings import Settings
from geometrikks.domain.geo.models import GeoLocation
from geometrikks.domain.geo.services import GeoLocationService
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
    SiteHomeView,
    DefaultHomeView,
    SiteHomesResponse,
)

from geometrikks.lib.parameters import (
    CityFilter,
    CountryCodeFilter,
    ToTimestamp,
    HostnameIn,
    IpAddressIn,
    IpAddressNotIn,
    FromTimestamp,
)
from geometrikks.lib.time import ensure_utc
from geometrikks.lib.validation import validate_ip_addresses
from geometrikks.server import runtime
from geometrikks.server.logging import get_logger
from geometrikks.services.geoip.home import HomeLocation
from geometrikks.services.geoip.site_homes import delete_site_home, fetch_last_event_days, fetch_site_homes

logger = get_logger(__name__)

class GeoLocationController(Controller):
    """Geo-location endpoints for managing location data."""

    path = "/geo-locations"
    tags = ["Geo Locations"]
    return_dto = GeoLocationDTO

    dependencies = create_service_dependencies(
        GeoLocationService,
        key="geo_location_service",
        # No config here: constructing it needs Settings(), which must not run
        # at import time. The service provider falls back to the request-scoped
        # ``db_session`` dependency registered by SQLAlchemyInitPlugin.
        filters={
            "pagination_type": "limit_offset",   # -> ?currentPage & ?pageSize
            "pagination_size": 10,               # matches the old global provider
        },
    )

    @get("/")
    async def list_geo_locations(
        self,
        geo_location_service: NamedDependency[GeoLocationService],
        filters: NamedDependency[SkipValidation[list[FilterTypes]]],
    ) -> OffsetPagination[GeoLocation]:
        """List all geo-locations with pagination."""
        results, total = await geo_location_service.get_many_and_count(*filters)
        return geo_location_service.to_schema(results, total, filters=filters)

    @get("/geojson", return_dto=None, description="Get all locations with event counts as GeoJSON FeatureCollection.")
    async def get_geojson(
        self,
        geo_location_service: NamedDependency[GeoLocationService],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        country_code: CountryCodeFilter = None,
        city: CityFilter = None,
        ip_address_in: IpAddressIn = None,
        ip_address_not_in: IpAddressNotIn = None,
        hostname_in: HostnameIn = None,
    ) -> GeoJSONFeatureCollection:
        """Get all locations with event counts as GeoJSON FeatureCollection.

        Returns a GeoJSON FeatureCollection where each feature represents a
        location with its coordinates and properties including the event count.
        An IP filter always forces a raw geo_events scan, bounded by raw
        retention. A hostname filter forces the raw scan only until the
        location CAGGs carry the hostname dimension (pre-upgrade or
        pollution-skipped installs); once they do, it reads the CAGGs.
        Args:
            from_datetime: Start datetime for filtering events.
            to_datetime: End datetime for filtering events.
        Returns:
            GeoJSONFeatureCollection containing locations and their event counts.
        """
        from_timestamp = ensure_utc(from_timestamp)
        to_timestamp = ensure_utc(to_timestamp)
        if ip_address_in:
            validate_ip_addresses(ip_address_in)
        if ip_address_not_in:
            validate_ip_addresses(ip_address_not_in)

        locations_with_counts = await geo_location_service.get_all_with_event_counts(
            from_timestamp, to_timestamp, country_codes=country_code, cities=city,
            ip_addresses=ip_address_in, ip_addresses_exclude=ip_address_not_in,
            hostnames=hostname_in,
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

    @get("/site-homes", return_dto=None, description="Per-source home locations for the map.")
    async def site_homes(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> SiteHomesResponse:
        """Merged site_homes rows plus the instance default home.

        The default mirrors read_settings's fallback: the app-state home
        resolved at startup, or the configured coordinates if resolution
        found nothing (geo-degraded or auto-detect disabled).
        """
        rows = await fetch_site_homes(db_session)
        last_days = await fetch_last_event_days(db_session) if rows else {}
        home: HomeLocation | None = runtime.get_map_home_location(request.app)
        if home is None and settings.map.home_latitude is not None and settings.map.home_longitude is not None:
            home = HomeLocation(
                latitude=settings.map.home_latitude,
                longitude=settings.map.home_longitude,
                source="configured",
            )
        return SiteHomesResponse(
            homes=[
                SiteHomeView(
                    hostname=r.hostname,
                    latitude=r.latitude,
                    longitude=r.longitude,
                    source=cast(Literal["auto", "override"], r.source),
                    detected_at=r.detected_at.isoformat() if r.detected_at else None,
                    last_event_day=last_days[r.hostname].date().isoformat() if r.hostname in last_days else None,
                )
                for r in rows
            ],
            default=DefaultHomeView(latitude=home.latitude, longitude=home.longitude) if home else None,
        )

    @delete(
        "/site-homes/{hostname:str}",
        return_dto=None,
        description="Remove a retired source's auto-detected home. Override rows (MAP_HOME_LOCATIONS) cannot be removed here.",
    )
    async def delete_site_home(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        hostname: Annotated[str, PathParameter(description="Recording hostname whose home row to remove")],
    ) -> None:
        await delete_site_home(db_session, hostname)
        user = request.scope.get("user")
        logger.info("Site home removed by %s: hostname=%s", str(user) if user else "unknown", hostname)

    @get("/top-ips", return_dto=None, description="Get global top IPs by event count with their primary locations.")
    async def get_global_top_ips(
        self,
        geo_location_service: NamedDependency[GeoLocationService],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        limit: Annotated[
            int,
            QueryParameter(description="Maximum number of IPs to return", ge=1, le=20),
        ] = 5,
    ) -> GlobalTopIPsResponse:
        """Get global top IPs by event count with their primary locations.

        Returns the top N IPs globally with the highest event counts,
        along with the location where each IP has the most events.
        """
        from_timestamp = ensure_utc(from_timestamp)
        to_timestamp = ensure_utc(to_timestamp)

        global_top_ips_data = await geo_location_service.get_global_top_ips(
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
        geo_location_service: NamedDependency[GeoLocationService],
        location_id: Annotated[int, PathParameter()],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        limit: Annotated[
            int,
            QueryParameter(description="Maximum number of IPs to return", ge=1, le=20),
        ] = 5,
    ) -> LocationTopIPsResponse:
        """Get top IPs for a specific location.

        Returns the top N IPs with the highest event counts for the given location.
        """
        from_timestamp = ensure_utc(from_timestamp)
        to_timestamp = ensure_utc(to_timestamp)

        top_ips_data = await geo_location_service.get_location_top_ips(
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
        geo_location_service: NamedDependency[GeoLocationService],
        from_timestamp: FromTimestamp,
        to_timestamp: ToTimestamp,
        limit: Annotated[
            int,
            QueryParameter(description="Maximum number of countries to return", ge=1, le=50),
        ] = 10,
    ) -> TopCountriesResponse:
        """Get top countries by event count.

        Returns the top N countries with the highest event counts.
        """
        from_timestamp = ensure_utc(from_timestamp)
        to_timestamp = ensure_utc(to_timestamp)

        top_countries_data = await geo_location_service.get_top_countries(
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