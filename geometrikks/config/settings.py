import socket
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from geometrikks.services.logparser.constants import ALLOWED_GEOIP_LOCALES


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
    password: str = Field(default="geopass", description="Database password")
    host: str = Field(default="localhost", description="Database host")
    port: int = Field(default=5432, description="Database port")
    database: str = Field(default="geometrikks", description="Database name")
    drop_on_startup: bool = Field(default=False, description="Drop all tables on startup (development only)")
    
    @property
    def url(self) -> str:
        """Construct the database URL from components."""
        return f"postgresql+asyncpg://{self.user}:{self.password}@{self.host}:{self.port}/{self.database}"
    

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

    model_config = SettingsConfigDict(env_prefix="GEOIP_", env_file=".env", extra="ignore")

    db_path: Path = Field(
        default=Path("data/GeoLite2-City.mmdb"),
        description="Path to GeoIP2/GeoLite2 database file",
    )
    locales: list[str] = Field(
        default=["en"],
        description="List of GeoIP locales to use",
    )
    cache_enabled: bool = Field(default=True, description="Enable GeoIP lookup caching")
    cache_ttl: int = Field(default=86400, description="GeoIP cache TTL in seconds (24 hours)")
    validate_db_path: bool = Field(
        default=False, 
        description="Validate that the GeoIP database file exists (set to True for production)"
    )
    validate_locales: bool = Field(
        default=True, 
        description="Validate that the specified GeoIP locales are supported"
    )

    @model_validator(mode="after")
    def validate_geoip_db_exists(self) -> "GeoIPSettings":
        """Ensure GeoIP database file exists if validation is enabled."""
        if self.validate_db_path and not self.db_path.exists():
            raise ValueError(f"GeoIP database file not found: {self.db_path}")
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
    workers: int = Field(default=5, description="Number of worker processes")
    reload: bool = Field(default=False, description="Enable auto-reload on code changes")
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = Field(
        default="INFO",
        description="Logging level",
    )


class LogParserSettings(BaseSettings):
    """Log parser configuration settings."""

    model_config = SettingsConfigDict(env_prefix="LOGPARSER_", env_file=".env", extra="ignore")

    log_path: Path = Field(
        default=Path("/var/log/nginx/access.log"),
        description="Path to the nginx access log file",
    )
    poll_interval: float = Field(
        default=1.0,
        description="Interval in seconds to poll the log file for new entries",
    )
    send_logs: bool = Field(default=True, description="Send parsed logs to the database")
    host_name: str = Field(
        default=socket.gethostname(),
        description="Host name for log parser (used in log entries)"
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


class AnalyticsSettings(BaseSettings):
    """Analytics and aggregation configuration settings."""

    model_config = SettingsConfigDict(env_prefix="ANALYTICS_", env_file=".env", extra="ignore")

    hourly_retention_days: int = Field(
        default=30,
        description="Number of days to keep hourly stats before cleanup",
    )
    enable_real_time: bool = Field(
        default=True,
        description="Enable real-time aggregation during log ingestion",
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
        default=5,
        description="Minutes between GeoLocation.last_hit refresh jobs",
    )

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
        DB_URL=postgresql+asyncpg://user:pass@localhost/geometrikks
        REDIS_URL=redis://localhost:6379/0
        GEOIP_DB_PATH=/data/GeoLite2-City.mmdb
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
    version: str = Field(default="0.1.0", description="Application version")
    description: str = Field(
        default="Real-time GeoIP lookups and traffic analytics API",
        description="Application description",
    )
    debug: bool = Field(default=False, description="Enable debug mode")
    environment: Literal["development", "staging", "production"] = Field(
        default="development",
        description="Application environment",
    )

    # Sub-configurations
    api: APISettings = Field(default_factory=APISettings)
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
    geoip: GeoIPSettings = Field(default_factory=GeoIPSettings)
    logparser: LogParserSettings = Field(default_factory=LogParserSettings)
    analytics: AnalyticsSettings = Field(default_factory=AnalyticsSettings)
    scheduler: SchedulerSettings = Field(default_factory=SchedulerSettings)
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
    # Create settings with validation disabled for GeoIP path by default
    # Set GEOIP_VALIDATE_DB_PATH=true in production to enable validation
    return Settings()
