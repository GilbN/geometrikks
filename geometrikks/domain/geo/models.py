from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    Float,
    BigInteger,
    String,
    Index,
    ForeignKey,
    UniqueConstraint,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column, relationship
from advanced_alchemy.types import DateTimeUTC
from advanced_alchemy.extensions.litestar import base
from geoalchemy2 import Geography
from litestar.dto import dto_field

from geometrikks.domain.geo.utils import WGS84_SRID

class GeoLocation(base.BigIntAuditBase):
    """Normalized geo-location data to avoid duplication.

    Stores unique combinations of geographic coordinates and location metadata.
    Referenced by GeoEvent to minimize data redundancy.
    """

    __tablename__ = "geo_locations"

    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)

    # Geohash for spatial queries (unique constraint provides the index)
    geohash: Mapped[str] = mapped_column(String(12), nullable=False)

    # PostGIS geography for spatial queries
    geographic_point: Mapped[str] = mapped_column(
        Geography(geometry_type="POINT", srid=WGS84_SRID), nullable=False
    )

    country_code: Mapped[str] = mapped_column(String(2), nullable=False, index=True)
    country_name: Mapped[str] = mapped_column(String(100), nullable=False)

    state: Mapped[Optional[str]] = mapped_column(String(100))
    state_code: Mapped[Optional[str]] = mapped_column(String(10))

    city: Mapped[Optional[str]] = mapped_column(String(100))
    postal_code: Mapped[Optional[str]] = mapped_column(String(20))

    timezone: Mapped[Optional[str]] = mapped_column(String(50))

    # Track when this location was last accessed
    last_hit: Mapped[Optional[datetime]] = mapped_column(
        DateTimeUTC(timezone=True),
        nullable=True,
        index=True,
        comment="Timestamp of the most recent access to this location"
    )

    geo_events: Mapped[list["GeoEvent"]] = relationship(
        "GeoEvent", back_populates="location", lazy="selectin"
    )

    # Unique constraint on geohash to prevent duplicates
    # Note: geographic_point already has a GiST spatial index via Geography(spatial_index=True) default
    __table_args__ = (
        UniqueConstraint("geohash", name="uq_geohash"),
        Index("ix_geo_locations_country_city", "country_code", "city"),
        Index("ix_geo_locations_coordinates", "latitude", "longitude"),
    )

    def __repr__(self) -> str:
        return f"<GeoLocation(id={self.id}, geohash={self.geohash}, country={self.country_code}, city={self.city})>"


class GeoEvent(base.BigIntBase):
    """Geo-location tracking events.

    High-volume time-series data tracking IP addresses and their geographic locations.
    Optimized for write-heavy workloads with partitioning support.
    """

    __tablename__ = "geo_events"

    # Event timestamp (main query field - use BRIN index in PostgreSQL)
    timestamp: Mapped[datetime] = mapped_column(
        DateTimeUTC(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
        info=dto_field("read-only")
    )

    # IP address that triggered the event
    ip_address: Mapped[str] = mapped_column(postgresql.INET, nullable=False, index=True, info=dto_field("read-only"))

    # Host that recorded the event, not the client hostname
    hostname: Mapped[str] = mapped_column(String(255), nullable=False, index=True, info=dto_field("read-only"))

    # Foreign key to normalized geo location
    location_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey(GeoLocation.id, ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # Relationships
    location: Mapped["GeoLocation"] = relationship(
        "GeoLocation", back_populates="geo_events", lazy="joined"
    )

    # Indexes optimized for common queries
    __table_args__ = (
        Index("ix_geo_events_timestamp_desc", "timestamp", postgresql_using="brin"),
        Index("ix_geo_events_ip_timestamp", "ip_address", "timestamp"),
        Index("ix_geo_events_hostname_timestamp", "hostname", "timestamp"),
        Index("ix_geo_events_location_timestamp", "location_id", "timestamp"),
    )

    def __repr__(self) -> str:
        return f"<GeoEvent(id={self.id}, ip={self.ip_address}, timestamp={self.timestamp})>"
