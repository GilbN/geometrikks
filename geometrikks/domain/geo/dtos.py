"""DTOs for geo-location and geo-event data transfer."""

from __future__ import annotations
from datetime import datetime
from typing import Annotated, Literal

import msgspec

from advanced_alchemy.extensions.litestar import SQLAlchemyDTO, SQLAlchemyDTOConfig
from geometrikks.domain.geo.models import GeoEvent, GeoLocation
from geometrikks.domain.geo.schemas import AsnOrganization


class GeoEventDTO(SQLAlchemyDTO[GeoEvent]):
    """Data transfer object for GeoEvent model."""

    config = SQLAlchemyDTOConfig(rename_strategy="camel")


class GeoLocationDTO(SQLAlchemyDTO[GeoLocation]):
    """Data transfer object for GeoLocation model."""

    config = SQLAlchemyDTOConfig(
        rename_strategy="camel",
        exclude={"geo_events"},
    )


LocationId = Annotated[int, msgspec.Meta(description="The location's `id`, as `/api/v1/geo-locations` lists it.")]


class EmbeddedLocationDTO(msgspec.Struct, rename="camel"):
    """The place and coordinates of one location."""

    id: LocationId
    latitude: float
    longitude: float
    city: str | None = None
    country_code: str | None = None
    country_name: str | None = None


class TopIPDTO(msgspec.Struct, rename="camel"):
    """One client IP with its geo events at one location."""

    ip_address: str
    event_count: Annotated[int, msgspec.Meta(description="The IP's events at this one location in the range.")]
    location: Annotated[
        EmbeddedLocationDTO | None,
        msgspec.Meta(
            description=(
                "The location where the IP had the most events, the one `eventCount` counts. Null in the top "
                "IPs of a single location."
            )
        ),
    ] = None
    asn: Annotated[
        int | None,
        msgspec.Meta(
            description=(
                "The IP's network. Set only in the top IPs of a single location, and null there when GeoIP had "
                "no ASN for the IP. On ranges up to 24 hours it comes from the IP's newest event with an ASN. On "
                "longer ranges it comes from the newest hour or UTC day with one. If the IP changed networks within "
                "that hour or day, `asn` and `asOrganization` can each come from a different network."
            )
        ),
    ] = None
    as_organization: AsnOrganization = None


# The geometry fields have no defaults on purpose. A default makes them
# optional in OpenAPI and in the generated TS client.
class GeoJSONPointGeometry(msgspec.Struct, rename="camel"):
    """A GeoJSON point."""

    type: Literal["Point"]
    coordinates: Annotated[
        tuple[float, float], msgspec.Meta(description="`[longitude, latitude]`, in GeoJSON order.")
    ]


class GeoJSONFeatureProperties(msgspec.Struct, rename="camel"):
    """One location and its events in the range."""

    id: LocationId
    geohash: str
    country_code: str
    country_name: str
    last_hit: Annotated[
        datetime | None,
        msgspec.Meta(
            description=(
                "The newest event at this location, whatever the range. A scheduler job on the head moves it "
                "forward every SCHEDULER_LOCATION_REFRESH_INTERVAL_MINUTES minutes, 10 by default. Null until the "
                "job first runs for the location. It keeps its last value while SCHEDULER_ENABLED=false or while "
                "the job fails."
            )
        ),
    ]
    state: str | None
    state_code: str | None
    city: str | None
    postal_code: str | None
    timezone: Annotated[str | None, msgspec.Meta(description="The location's IANA timezone from GeoIP.")]
    event_count: Annotated[int, msgspec.Meta(description="Events at this location in the range.")]
    top_ips: Annotated[
        list[TopIPDTO],
        msgspec.Meta(description="Always empty here. `/api/v1/geo-locations/{location_id}/top-ips` lists them."),
    ] = msgspec.field(default_factory=list)


class GeoJSONFeature(msgspec.Struct, rename="camel"):
    """One location as a GeoJSON Feature."""

    type: Annotated[str, msgspec.Meta(description="Always `Feature`.")]
    geometry: GeoJSONPointGeometry
    properties: GeoJSONFeatureProperties

class GeoJSONFeatureStats(msgspec.Struct, rename="camel"):
    """Totals over every feature in the collection."""

    events: int
    countries: Annotated[int, msgspec.Meta(description="Distinct country codes.")]
    cities: Annotated[
        int,
        msgspec.Meta(description="Distinct city names. Cities with the same name in different countries count once."),
    ]
    locations: Annotated[int, msgspec.Meta(description="The number of features.")]

class GeoJSONFeatureCollection(msgspec.Struct, rename="camel"):
    """The locations with events in a time range, as a GeoJSON FeatureCollection, busiest first."""

    type: Annotated[str, msgspec.Meta(description="Always `FeatureCollection`.")]
    features: list[GeoJSONFeature]
    stats: GeoJSONFeatureStats


class LocationTopIPsResponse(msgspec.Struct, rename="camel"):
    """The client IPs with the most events at one location, most first."""

    location_id: LocationId
    unique_ips: Annotated[int, msgspec.Meta(description="Distinct client IPs at the location in the range.")]
    top_ips: list[TopIPDTO] = msgspec.field(default_factory=list)


class GlobalTopIPsResponse(msgspec.Struct, rename="camel"):
    """The client IPs with the most events, each at the location where it had the most."""

    top_ips: list[TopIPDTO] = msgspec.field(default_factory=list)


class TopCountryDTO(msgspec.Struct, rename="camel"):
    """One country with its geo events."""

    country_code: str
    country_name: str | None
    event_count: int


class TopCountriesResponse(msgspec.Struct, rename="camel"):
    """Countries ordered by geo event count, most first."""

    top_countries: list[TopCountryDTO] = msgspec.field(default_factory=list)


class ServerLocationView(msgspec.Struct, rename="camel"):
    """Where one server sits on the map."""

    server: str
    latitude: float
    longitude: float
    source: Annotated[
        Literal["auto", "override"],
        msgspec.Meta(
            description=(
                "`auto` when the instance that tails the server recorded its own location, from its "
                "MAP_SERVER_LATITUDE and MAP_SERVER_LONGITUDE or from its public IP. `override` when "
                "MAP_SERVER_LOCATIONS on the head pins the server."
            )
        ),
    ]
    detected_at: Annotated[
        str | None,
        msgspec.Meta(description="When the instance last recorded the location, as ISO 8601. Null for an override."),
    ]
    last_event_day: Annotated[
        str | None,
        msgspec.Meta(
            description="The UTC day of the server's newest geo event, as `YYYY-MM-DD`. Null when it has none."
        ),
    ]


class DefaultServerLocationView(msgspec.Struct, rename="camel"):
    """This instance's own location, which the map uses for a server without a location of its own."""

    latitude: float
    longitude: float


class ServerLocationsResponse(msgspec.Struct, rename="camel"):
    """Every server's map location, plus this instance's own location as the default."""

    locations: Annotated[list[ServerLocationView], msgspec.Meta(description="Sorted by server name.")]
    default: Annotated[
        DefaultServerLocationView | None,
        msgspec.Meta(
            description=(
                "This instance's own location, found at startup or set with MAP_SERVER_LATITUDE and "
                "MAP_SERVER_LONGITUDE. Null when it has neither."
            )
        ),
    ]
