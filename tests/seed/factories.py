"""Polyfactory-based factories for test data generation.

Uses SQLAlchemyFactory for type-safe, model-aware data generation
with custom providers for domain-specific fields.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone
from typing import Any, ClassVar, Generic, TypeVar

import geohash2
from faker import Faker
from geoalchemy2 import Geography
from polyfactory import Use, Ignore
from polyfactory.factories.sqlalchemy_factory import SQLAlchemyFactory

from geometrikks.domain.geo.models import GeoLocation, GeoEvent
from geometrikks.domain.logs.models import AccessLog, AccessLogDebug

T = TypeVar("T")


class BaseFactory(SQLAlchemyFactory[T], Generic[T]):
    """Base factory with custom type mappings for PostGIS types."""

    __is_base_factory__ = True

    @classmethod
    def get_sqlalchemy_types(cls) -> dict[type, Any]:
        """Add PostGIS Geography type mapping."""
        types = super().get_sqlalchemy_types()
        # Map Geography to string (WKT format)
        types[Geography] = str
        return types


# Shared Faker instance (seeded externally)
fake = Faker()

# Shared RNG (seeded externally)
rng = random.Random()


def seed_factories(seed: int) -> None:
    """Seed all random generators for reproducibility."""
    Faker.seed(seed)
    fake.seed_instance(seed)
    rng.seed(seed)


# Common user agents with realistic distribution
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Googlebot/2.1 (+http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "python-requests/2.31.0",
    "curl/8.4.0",
]

# Common URL paths
URL_PATHS = [
    "/",
    "/api/v1/health",
    "/api/v1/stats",
    "/api/v1/analytics/summary",
    "/api/v1/geo-events",
    "/api/v1/access-logs",
    "/static/js/main.js",
    "/static/css/styles.css",
    "/favicon.ico",
    "/robots.txt",
    "/sitemap.xml",
    "/login",
    "/dashboard",
    "/settings",
]


def _generate_geohash() -> str:
    """Generate a geohash from random coordinates."""
    lat = float(fake.latitude())
    lng = float(fake.longitude())
    return geohash2.encode(lat, lng, precision=8)


def _generate_geographic_point() -> str:
    """Generate a PostGIS POINT WKT string."""
    lat = float(fake.latitude())
    lng = float(fake.longitude())
    return f"SRID=4326;POINT({lng} {lat})"


def _generate_coordinates() -> tuple[float, float, str, str]:
    """Generate consistent lat/lng/geohash/point tuple."""
    lat = float(fake.latitude())
    lng = float(fake.longitude())
    gh = geohash2.encode(lat, lng, precision=8)
    point = f"SRID=4326;POINT({lng} {lat})"
    return lat, lng, gh, point


class GeoLocationFactory(BaseFactory[GeoLocation]):
    """Factory for GeoLocation model."""

    __model__ = GeoLocation
    __set_relationships__ = False

    # Ignore auto-generated fields and relationships
    id = Ignore()
    created_at = Ignore()
    updated_at = Ignore()
    geo_events = Ignore()

    @classmethod
    def build(cls, **kwargs: Any) -> GeoLocation:
        """Build with consistent coordinates."""
        if "latitude" not in kwargs or "longitude" not in kwargs:
            lat, lng, gh, point = _generate_coordinates()
            kwargs.setdefault("latitude", lat)
            kwargs.setdefault("longitude", lng)
            kwargs.setdefault("geohash", gh)
            kwargs.setdefault("geographic_point", point)

        kwargs.setdefault("country_code", fake.country_code())
        kwargs.setdefault("country_name", fake.country())
        kwargs.setdefault("state", fake.state() if rng.random() > 0.3 else None)
        kwargs.setdefault("state_code", fake.state_abbr() if rng.random() > 0.3 else None)
        kwargs.setdefault("city", fake.city() if rng.random() > 0.2 else None)
        kwargs.setdefault("postal_code", fake.postcode() if rng.random() > 0.4 else None)
        kwargs.setdefault("timezone", fake.timezone())
        kwargs.setdefault("last_hit", None)

        return super().build(**kwargs)

    @classmethod
    def build_dict(cls, **kwargs: Any) -> dict[str, Any]:
        """Build as dictionary for bulk inserts."""
        if "latitude" not in kwargs or "longitude" not in kwargs:
            lat, lng, gh, point = _generate_coordinates()
            kwargs.setdefault("latitude", lat)
            kwargs.setdefault("longitude", lng)
            kwargs.setdefault("geohash", gh)
            kwargs.setdefault("geographic_point", point)

        now = datetime.now(timezone.utc)
        return {
            "latitude": kwargs.get("latitude"),
            "longitude": kwargs.get("longitude"),
            "geohash": kwargs.get("geohash"),
            "geographic_point": kwargs.get("geographic_point"),
            "country_code": kwargs.get("country_code", fake.country_code()),
            "country_name": kwargs.get("country_name", fake.country()),
            "state": kwargs.get("state", fake.state() if rng.random() > 0.3 else None),
            "state_code": kwargs.get("state_code", fake.state_abbr() if rng.random() > 0.3 else None),
            "city": kwargs.get("city", fake.city() if rng.random() > 0.2 else None),
            "postal_code": kwargs.get("postal_code", fake.postcode() if rng.random() > 0.4 else None),
            "timezone": kwargs.get("timezone", fake.timezone()),
            "last_hit": kwargs.get("last_hit"),
            "created_at": now,
            "updated_at": now,
        }

    @classmethod
    def batch_dicts(cls, count: int, **kwargs: Any) -> list[dict[str, Any]]:
        """Generate multiple location dicts, ensuring unique geohashes."""
        locations = []
        seen_geohashes: set[str] = set()

        while len(locations) < count:
            loc = cls.build_dict(**kwargs)
            if loc["geohash"] not in seen_geohashes:
                seen_geohashes.add(loc["geohash"])
                locations.append(loc)

        return locations


class GeoEventFactory(BaseFactory[GeoEvent]):
    """Factory for GeoEvent model."""

    __model__ = GeoEvent
    __set_relationships__ = False

    # Ignore auto-generated fields and relationships
    id = Ignore()
    location = Ignore()

    # Custom field providers
    timestamp = Use(lambda: datetime.now(timezone.utc))
    ip_address = Use(lambda: fake.ipv4())
    hostname = Use(lambda: "geometrikks.local")

    @classmethod
    def build_dict(
        cls,
        location_id: int,
        timestamp: datetime | None = None,
        ip_address: str | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Build as dictionary for bulk inserts."""
        return {
            "timestamp": timestamp or datetime.now(timezone.utc),
            "ip_address": ip_address or fake.ipv4(),
            "hostname": kwargs.get("hostname", "geometrikks.local"),
            "location_id": location_id,
        }


class AccessLogFactory(BaseFactory[AccessLog]):
    """Factory for AccessLog model."""

    __model__ = AccessLog
    __set_relationships__ = False

    # Ignore auto-generated fields
    id = Ignore()

    # Status code weights for realistic distribution
    STATUS_WEIGHTS: ClassVar[dict[int, float]] = {
        200: 0.75, 201: 0.02, 204: 0.01,
        301: 0.03, 302: 0.02, 304: 0.05,
        400: 0.03, 401: 0.02, 403: 0.02, 404: 0.03,
        500: 0.01, 502: 0.005, 503: 0.005,
    }

    # Method weights
    METHOD_WEIGHTS: ClassVar[dict[str, float]] = {
        "GET": 0.85, "POST": 0.08, "PUT": 0.03,
        "DELETE": 0.02, "PATCH": 0.01, "OPTIONS": 0.01,
    }

    @classmethod
    def _random_status(cls) -> int:
        """Get weighted random status code."""
        codes = list(cls.STATUS_WEIGHTS.keys())
        weights = list(cls.STATUS_WEIGHTS.values())
        return rng.choices(codes, weights)[0]

    @classmethod
    def _random_method(cls) -> str:
        """Get weighted random HTTP method."""
        methods = list(cls.METHOD_WEIGHTS.keys())
        weights = list(cls.METHOD_WEIGHTS.values())
        return rng.choices(methods, weights)[0]

    @classmethod
    def _random_request_time(cls) -> float:
        """Generate log-normal distributed request time."""
        t = max(0.001, rng.lognormvariate(-2, 1.5))
        return round(min(t, 30.0), 3)

    @classmethod
    def _random_bytes(cls, status: int) -> int:
        """Generate bytes sent based on status code."""
        if status == 304:
            return 0
        if status >= 400:
            return rng.randint(100, 2000)
        return int(rng.lognormvariate(8, 2))

    @classmethod
    def build_dict(
        cls,
        timestamp: datetime | None = None,
        ip_address: str | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Build as dictionary for bulk inserts."""
        status = kwargs.get("status_code") or cls._random_status()
        method = kwargs.get("method") or cls._random_method()
        request_time = kwargs.get("request_time") or cls._random_request_time()

        url = kwargs.get("url") or rng.choice(URL_PATHS)
        if rng.random() < 0.3 and "?" not in url:
            url += f"?page={rng.randint(1, 100)}"

        return {
            "timestamp": timestamp or datetime.now(timezone.utc),
            "ip_address": ip_address or fake.ipv4(),
            "remote_user": kwargs.get("remote_user"),
            "method": method,
            "url": url,
            "http_version": kwargs.get("http_version", "HTTP/1.1" if rng.random() < 0.7 else "HTTP/2.0"),
            "status_code": status,
            "bytes_sent": kwargs.get("bytes_sent") or cls._random_bytes(status),
            "referrer": kwargs.get("referrer", fake.url() if rng.random() < 0.3 else None),
            "user_agent": kwargs.get("user_agent") or rng.choice(USER_AGENTS),
            "request_time": request_time,
            "upstream_response_time": kwargs.get("upstream_response_time", round(request_time * 0.1, 3) if rng.random() < 0.8 else None),
            "host": kwargs.get("host", "geometrikks.local"),
            "country_code": kwargs.get("country_code"),
            "country_name": kwargs.get("country_name"),
            "city": kwargs.get("city"),
        }


class AccessLogDebugFactory(BaseFactory[AccessLogDebug]):
    """Factory for AccessLogDebug model."""

    __model__ = AccessLogDebug
    __set_relationships__ = False

    # Ignore auto-generated fields
    id = Ignore()

    # Malformed request patterns
    MALFORMED_PATTERNS: ClassVar[list[str]] = [
        r'"\x16\x03\x01\x01-\x01\x00\x01)\x03\x03...',  # TLS handshake
        "SSH-2.0-OpenSSH_8.9",  # SSH probe
        r"\x00\x00\x00\x85\xffSMB...",  # SMB probe
        r"\x00\x01\x02\x03\x04\x05",  # Binary garbage
    ]

    @classmethod
    def build_dict(
        cls,
        is_malformed: bool = False,
        access_log_id: int | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Build as dictionary for bulk inserts."""
        created_at = kwargs.get("created_at") or datetime.now(timezone.utc)

        if is_malformed:
            pattern = rng.choice(cls.MALFORMED_PATTERNS)
            raw_line = f'{fake.ipv4()} - - [{fake.date_time()}] "{pattern}" 400 0 "-" "-"'
            parse_error = "Malformed request line"
        else:
            raw_line = f'{fake.ipv4()} - - [{fake.date_time()}] "GET / HTTP/1.1" 200 1234 "-" "curl/8.0"'
            parse_error = None

        return {
            "access_log_id": access_log_id,
            "created_at": created_at,
            "raw_line": kwargs.get("raw_line", raw_line),
            "is_malformed": is_malformed,
            "parse_error": kwargs.get("parse_error", parse_error),
        }
