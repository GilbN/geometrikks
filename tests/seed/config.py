"""Configuration for data seeding."""

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal


# PostgreSQL/asyncpg limit: 32767 parameters per query
# We need to calculate safe batch sizes based on column count
MAX_QUERY_PARAMS = 32767

# Column counts per model (used to calculate safe batch sizes)
COLUMNS_GEO_LOCATION = 15  # latitude, longitude, geohash, geographic_point, country_code, country_name, state, state_code, city, postal_code, timezone, last_hit, created_at, updated_at
COLUMNS_ACCESS_LOG = 17    # timestamp, ip_address, remote_user, method, url, http_version, status_code, bytes_sent, referrer, user_agent, request_time, upstream_response_time, host, country_code, country_name, city
COLUMNS_GEO_EVENT = 5      # timestamp, ip_address, hostname, location_id
COLUMNS_DEBUG_LOG = 6      # access_log_id, created_at, raw_line, is_malformed, parse_error


def safe_batch_size(num_columns: int, margin: float = 0.9) -> int:
    """Calculate safe batch size given column count.

    Args:
        num_columns: Number of columns in the table.
        margin: Safety margin (0.9 = use 90% of max).

    Returns:
        Maximum safe batch size.
    """
    return int((MAX_QUERY_PARAMS / num_columns) * margin)


@dataclass
class SeedConfig:
    """Configuration for data seeding operations.

    Attributes:
        seed: Random seed for reproducibility. Use same seed for identical data.
        batch_size: Number of rows to insert per batch (affects memory usage).
                    Note: Will be automatically capped based on column count to
                    stay under PostgreSQL's 32767 parameter limit.
        num_locations: Number of unique GeoLocation records to create.
        num_access_logs: Number of AccessLog records to create.
        num_geo_events: Number of GeoEvent records (typically same as access_logs).
        start_date: Start of the time range for generated timestamps.
        end_date: End of the time range for generated timestamps.
        malformed_ratio: Fraction of logs to mark as malformed (0.0-1.0).
        verbose: Print progress information.
    """

    seed: int = 42
    batch_size: int = 2000  # Safe default for all tables
    num_locations: int = 5_000
    num_access_logs: int = 100_000
    num_geo_events: int = 100_000
    start_date: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc) - timedelta(days=30)
    )
    end_date: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    malformed_ratio: float = 0.02  # 2% malformed requests
    verbose: bool = True

    # Distribution parameters
    ip_zipf_exponent: float = 1.5  # Higher = more skewed (few IPs dominate)
    location_zipf_exponent: float = 1.2  # Geographic clustering

    # Status code distribution (should sum to 1.0)
    status_weights: dict[int, float] = field(default_factory=lambda: {
        200: 0.75,
        201: 0.02,
        204: 0.01,
        301: 0.03,
        302: 0.02,
        304: 0.05,
        400: 0.03,
        401: 0.02,
        403: 0.02,
        404: 0.03,
        500: 0.01,
        502: 0.005,
        503: 0.005,
    })

    def __post_init__(self) -> None:
        if self.start_date.tzinfo is None:
            self.start_date = self.start_date.replace(tzinfo=timezone.utc)
        if self.end_date.tzinfo is None:
            self.end_date = self.end_date.replace(tzinfo=timezone.utc)
