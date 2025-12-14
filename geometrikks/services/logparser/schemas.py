"""Schemas for parsed log data - pure data, no ORM dependencies."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class ParsedGeoData:
    """Geographic data extracted from GeoIP lookup."""

    latitude: float
    longitude: float
    geohash: str
    country_code: str
    country_name: str
    state: str | None = None
    state_code: str | None = None
    city: str | None = None
    postal_code: str | None = None
    timezone: str | None = None


@dataclass
class ParsedAccessLog:
    """Parsed nginx access log entry."""

    timestamp: datetime
    ip_address: str
    remote_user: str | None
    method: str | None
    url: str | None
    http_version: str | None
    status_code: int
    bytes_sent: int
    referrer: str | None
    user_agent: str | None
    request_time: float
    connect_time: float | None
    host: str | None
    country_code: str | None
    country_name: str | None
    city: str | None


@dataclass
class ParsedLogRecord:
    """Complete parsed log record ready for ingestion service.

    This is a pure data container with no ORM dependencies.
    The ingestion service converts this to ORM models.
    """

    ip_address: str | None
    geo_data: ParsedGeoData | None
    access_log: ParsedAccessLog | None
    raw_line: str
    is_malformed: bool = field(default=False)
    parse_error: str | None = field(default=None)
