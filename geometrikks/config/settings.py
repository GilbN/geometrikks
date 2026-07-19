import json
import socket
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version as distribution_version
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from geometrikks.services.logparser.constants import ALLOWED_GEOIP_LOCALES


def get_installed_version() -> str:
    """Return the version of the installed GeoMetrikks distribution.

    The application is packaged during normal ``uv sync`` and image builds, so
    distribution metadata is the single source of truth for the running
    version. The fallback keeps direct source execution usable before install.
    """
    try:
        return distribution_version("geometrikks")
    except PackageNotFoundError:
        return "unknown"


class DatabaseSettings(BaseSettings):
    """Database configuration settings.
    
    PostgreSQL with PostGIS is required for this application due to
    GeoAlchemy2 spatial features and high-volume log ingestion.
    """

    model_config = SettingsConfigDict(env_prefix="DB_", env_file=".env", extra="ignore")

    echo: bool = Field(default=False, description="Enable SQLAlchemy query logging")
    echo_pool: bool = Field(default=False, description="Enable SQLAlchemy pool logging")
    max_overflow: int = Field(default=10, description="Max connections above pool_size")
    pool_size: int = Field(default=5, description="Database connection pool size")
    pool_timeout: int = Field(default=30, description="Connection pool timeout in seconds")
    pool_recycle: int = Field(default=3600, description="Connection recycle time in seconds")
    pool_disabled: bool = Field(default=False, description="Disable connection pooling")
    pool_pre_ping: bool = Field(default=True, description="Enable pool pre-ping to check connections")
    user: str = Field(default="geouser", description="Database user")
    password: SecretStr = Field(default=SecretStr("geopass"), description="Database password")
    host: str = Field(default="localhost", description="Database host")
    port: int = Field(default=5432, description="Database port")
    database: str = Field(default="geometrikks", description="Database name")
    drop_on_startup: bool = Field(default=False, description="Drop all tables on startup (development only)")
    
    @property
    def url(self) -> str:
        """Construct the database URL from components."""
        return (
            f"postgresql+asyncpg://{self.user}:{self.password.get_secret_value()}"
            f"@{self.host}:{self.port}/{self.database}"
        )
    

    @model_validator(mode="after")
    def validate_db_url(self) -> "DatabaseSettings":
        """Ensure database URL is a valid PostgreSQL connection string."""
        if not self.url.startswith(("postgresql", "postgresql+asyncpg")):
            raise ValueError(
                "Database URL must be PostgreSQL with asyncpg driver. "
                "Example: postgresql+asyncpg://user:pass@localhost/geometrikks"
            )
        return self


class GeoIPSettings(BaseSettings):
    """GeoIP database configuration settings."""

    # populate_by_name: account_id/license_key use MAXMINDDB_* validation
    # aliases for the env vars but must stay constructible by field name.
    model_config = SettingsConfigDict(
        env_prefix="GEOIP_", env_file=".env", extra="ignore", populate_by_name=True
    )

    db_path: Path = Field(
        default=Path("data/geoip/GeoLite2-City.mmdb"),
        description="Path to GeoIP2/GeoLite2 database file",
    )
    locales: list[str] = Field(
        default=["en"],
        description="List of GeoIP locales to use",
    )
    validate_db_path: bool = Field(
        default=False,
        description=(
            "Fail settings validation when the GeoIP database file is missing. "
            "Off by default: the auto-downloader/degraded-mode path owns the "
            "missing-file case (set true to fail fast instead)."
        ),
    )
    validate_locales: bool = Field(
        default=True,
        description="Validate that the specified GeoIP locales are supported"
    )
    account_id: str | None = Field(
        default=None,
        validation_alias="MAXMINDDB_USER_ID",
        description="MaxMind account ID for GeoLite2 auto-download",
    )
    license_key: SecretStr | None = Field(
        default=None,
        validation_alias="MAXMINDDB_LICENSE_KEY",
        description="MaxMind license key for GeoLite2 auto-download",
    )
    refresh_days: int = Field(
        default=7, description="Re-download the GeoLite2 database when older than this many days"
    )

    @model_validator(mode="after")
    def validate_geoip_db_exists(self) -> "GeoIPSettings":
        """Ensure GeoIP database file exists if validation is enabled.

        Resolves relative paths from the project root to work in all contexts.
        """
        db_path = self.db_path

        # If path is relative, resolve from project root
        if not db_path.is_absolute():
            project_root = Path(__file__).parent.parent.parent
            db_path = project_root / db_path

        if self.validate_db_path and not db_path.exists():
            raise ValueError(f"GeoIP database file not found: {db_path}")

        # Update the path to absolute for runtime use
        self.db_path = db_path
        return self

    @model_validator(mode="after")
    def validate_geoip_locales(self) -> "GeoIPSettings":
        """Ensure GeoIP locales are valid if validation is enabled."""
        if self.validate_locales:
            invalid_locales = [loc for loc in self.locales if loc not in ALLOWED_GEOIP_LOCALES]
            if invalid_locales:
                raise ValueError(f"Invalid GeoIP locales: {invalid_locales}. Allowed locales are: {ALLOWED_GEOIP_LOCALES}")
        return self


class APISettings(BaseSettings):
    """API server configuration settings."""

    model_config = SettingsConfigDict(env_prefix="API_", env_file=".env", extra="ignore")

    host: str = Field(default="0.0.0.0", description="API server host")
    port: int = Field(default=8000, description="API server port")
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = Field(
        default="INFO",
        description="Logging level",
    )


class LogParserSettings(BaseSettings):
    """Log parser configuration settings."""

    model_config = SettingsConfigDict(env_prefix="LOGPARSER_", env_file=".env", extra="ignore")

    log_paths: Annotated[list[Path], NoDecode] = Field(
        default_factory=lambda: [Path("/var/log/nginx/access.log")],
        min_length=1,
        description=(
            "Nginx access log files to tail. Env accepts a single path or a JSON "
            "list of paths. Default: /var/log/nginx/access.log"
        ),
    )
    poll_interval: float = Field(
        default=1.0,
        description="Interval in seconds to poll the log file for new entries",
    )
    send_logs: bool = Field(default=True, description="Send parsed logs to the database")
    host_name: str = Field(
        default_factory=socket.gethostname,
        description="Host name for log parser (used in log entries)",
    )
    batch_size: int = Field(
        default=100,
        description="Max records before forced commit.",
    )
    commit_interval: float = Field(
        default=5.0,
        description="Maximum time interval in seconds between database commits. This will commit even if batch_size is not reached.",
    )
    skip_validation : bool = Field(
        default=False,
        description="Skip validation of log lines.",
    )
    store_debug_lines: bool = Field(
        default=False,
        description="Store all raw log lines in AccessLogDebug table. When False, only malformed requests are stored.",
    )

    @field_validator("log_paths", mode="before")
    @classmethod
    def parse_log_paths(cls, value: object) -> object:
        """Accept a single path (str/Path) or a JSON list of paths."""
        if isinstance(value, Path):
            return [value]
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith("["):
                return json.loads(stripped)
            return [stripped]
        return value


class AnalyticsSettings(BaseSettings):
    """Analytics and aggregation configuration settings.

    TimescaleDB handles retention via policies configured in lifecycle.py.
    These settings define the default retention periods.
    """

    model_config = SettingsConfigDict(env_prefix="ANALYTICS_", env_file=".env", extra="ignore")

    # Retention periods for TimescaleDB policies
    raw_retention_days: int = Field(
        default=180,
        description="Days to keep raw geo_events and access_logs data",
    )
    debug_retention_days: int = Field(
        default=30,
        description="Days to keep access_log_debug data",
    )
    hourly_retention_days: int = Field(
        default=60,
        description="Days to keep hourly continuous aggregate data",
    )
    # Daily aggregates are permanent (no retention)

    # Continuous aggregate refresh settings
    cagg_refresh_interval_minutes: int = Field(
        default=5,
        description="Minutes between continuous aggregate refreshes",
    )

    # Compression settings
    compression_after_days: int = Field(
        default=7,
        description="Days after which to compress hypertable chunks",
    )

    top_ips_limit: int = Field(
        default=1000,
        description="Maximum number of top IPs to track per day",
    )
    top_urls_limit: int = Field(
        default=500,
        description="Maximum number of top URLs to track per day",
    )


class SchedulerSettings(BaseSettings):
    """APScheduler configuration for periodic background tasks."""

    model_config = SettingsConfigDict(env_prefix="SCHEDULER_", env_file=".env", extra="ignore")

    enabled: bool = Field(
        default=True,
        description="Enable scheduled background tasks",
    )
    daily_rollup_hour: int = Field(
        default=0,
        description="Hour (UTC, 0-23) to run daily rollup",
    )
    daily_rollup_minute: int = Field(
        default=5,
        description="Minute (0-59) to run daily rollup",
    )
    location_refresh_interval_minutes: int = Field(
        default=10,
        description="Minutes between GeoLocation.last_hit refresh jobs",
    )


class MapSettings(BaseSettings):
    """Map presentation settings shared with the web client."""

    model_config = SettingsConfigDict(env_prefix="MAP_", env_file=".env", extra="ignore")

    home_latitude: float | None = Field(
        default=None,
        ge=-90,
        le=90,
        description=(
            "Optional destination latitude for live request routes. Set both home "
            "coordinates to override external-IP auto-detection."
        ),
    )
    home_longitude: float | None = Field(
        default=None,
        ge=-180,
        le=180,
        description=(
            "Optional destination longitude for live request routes. Set both home "
            "coordinates to override external-IP auto-detection."
        ),
    )
    auto_detect_home: bool = Field(
        default=True,
        description=(
            "Resolve the server's public IP at startup and geolocate it when "
            "home coordinates are unset."
        ),
    )
    public_ip_url: str = Field(
        default="https://api64.ipify.org?format=json",
        description=(
            "JSON endpoint used for public-IP discovery; the response must "
            "contain an 'ip' field."
        ),
    )
    public_ip_timeout: float = Field(
        default=3.0,
        gt=0,
        le=30,
        description="Timeout in seconds for public-IP discovery.",
    )

    @model_validator(mode="after")
    def validate_home_coordinate_pair(self) -> "MapSettings":
        """Require both manual coordinates or neither."""
        if (self.home_latitude is None) != (self.home_longitude is None):
            raise ValueError("MAP_HOME_LATITUDE and MAP_HOME_LONGITUDE must be set together")
        return self


class ViteSettings(BaseSettings):
    """Vite server configuration settings."""

    model_config = SettingsConfigDict(env_prefix="VITE_", env_file=".env", extra="ignore")

    dev_mode: bool = Field(
        default=False,
        description="Start vite development server."
    )
    use_server_lifespan: bool = Field(
        default=True,
        description="Auto start and stop vite processes when running in development mode."
    )
    host: str = Field(
        default="0.0.0.0",
        description="The host the vite process will listen on. Defaults to 0.0.0.0."
    )
    port: int = Field(
        default=5173,
        description="The port to start vite on. Default is 5173."
    )
    hot_reload: bool = Field(
        default=True,
        description="Start vite with HMR enabled."
    )
    enable_react_helpers: bool = Field(
        default=True,
        description="Enable React support in HMR."
    )
    http2: bool = Field(
        default=True,
        description="Enable HTTP/2 for the Vite development server."
    )

    executor: Literal["node", "bun", "deno", "yarn", "pnpm"] | None = Field(
        default="bun",
        description="JS runtime executor for litestar-vite (defaults to bun).",
    )


class Settings(BaseSettings):
    """Main application settings.
    
    This class aggregates all configuration sections and provides
    a single point of access for application configuration.
    
    Configuration precedence (highest to lowest):
    1. Environment variables
    2. .env file
    3. Default values
    
    Example .env file:
        APP_NAME=GeoMetrikks
        APP_DEBUG=true
        GEOIP_DB_PATH=data/GeoLite2-City.mmdb
    """

    model_config = SettingsConfigDict(
        env_prefix="APP_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Application metadata
    name: str = Field(default="GeoMetrikks API", description="Application name")
    version: str = Field(
        default_factory=get_installed_version,
        description="Application version (defaults to installed package metadata)",
    )
    description: str = Field(
        default="Real-time GeoIP lookups and traffic analytics API",
        description="Application description",
    )
    debug: bool = Field(default=False, description="Enable debug mode")
    environment: Literal["development", "staging", "production"] = Field(
        default="production",
        description="Application environment",
    )
    runtime: Literal["host", "container"] = Field(
        default="host",
        description="Execution runtime; container images set this to container.",
    )
    image_tag: str | None = Field(
        default=None,
        description="Optional container image tag embedded at build time.",
    )

    # Authentication (single admin user; see Phase 1c design)
    auth_disabled: bool = Field(
        default=False,
        description=(
            "Disable the built-in session auth entirely. Set true only when an "
            "authenticating reverse proxy (Authelia, Tailscale, ...) fronts the app."
        ),
    )
    admin_user: str = Field(default="admin", description="Admin login username")
    admin_password: SecretStr | None = Field(
        default=None,
        description="Admin login password (required unless auth_disabled=true)",
    )

    # Sub-configurations
    api: APISettings = Field(default_factory=APISettings)
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
    geoip: GeoIPSettings = Field(default_factory=GeoIPSettings)
    logparser: LogParserSettings = Field(default_factory=LogParserSettings)
    analytics: AnalyticsSettings = Field(default_factory=AnalyticsSettings)
    scheduler: SchedulerSettings = Field(default_factory=SchedulerSettings)
    map: MapSettings = Field(default_factory=MapSettings)
    vite: ViteSettings = Field(default_factory=ViteSettings)

    @property
    def is_production(self) -> bool:
        """Check if running in production environment."""
        return self.environment == "production"

    @property
    def is_development(self) -> bool:
        """Check if running in development environment."""
        return self.environment == "development"


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance.
    
    This function is cached to ensure we only parse configuration once.
    Use this function throughout the application to access settings.
    
    Returns:
        Settings: Application settings instance
    """
    return Settings()
