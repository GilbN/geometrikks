"""DTOs for geo-location and geo-event data transfer."""
from __future__ import annotations

from advanced_alchemy.extensions.litestar import SQLAlchemyDTO, SQLAlchemyDTOConfig

from geometrikks.domain.geo.models import GeoEvent, GeoLocation

class GeoEventDTO(SQLAlchemyDTO[GeoEvent]):
    """Data transfer object for GeoEvent model."""
    config = SQLAlchemyDTOConfig(rename_strategy="camel")

class GeoLocationDTO(SQLAlchemyDTO[GeoLocation]):
    """Data transfer object for GeoLocation model."""
    config = SQLAlchemyDTOConfig(
        rename_strategy="camel",
        exclude={"geo_events"},
        )