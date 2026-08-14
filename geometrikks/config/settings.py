import json
import os
import socket
import warnings
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version as distribution_version
from ipaddress import ip_network
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from geometrikks.services.logparser.constants import ALLOWED_GEOIP_LOCALES


def _env_file() -> str | None:
    """Resolve the dotenv path used by every settings section.

    GEOMETRIKKS_ENV_FILE overrides the default ``.env``; an empty value
    disables dotenv loading entirely. The test suite sets it empty before
    this module is imported so results never depend on a developer's local
    ``.env``. Evaluated at class-creation time, like the rest of
    ``model_config``.
    """
    return os.environ.get("GEOMETRIKKS_ENV_FILE", ".env") or None


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

    model_config = SettingsConfigDict(env_prefix="DB_", env_file=_env_file(), extra="ignore")

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
    migrate_on_startup: bool = Field(
        default=True,
        description=(
            "Run alembic migrations automatically at app startup. Disable when "
            "migrations run as a separate deployment step (`litestar database "
            "upgrade`); the app then expects the schema to already be at head "
            "and fails startup if it is not usable"
        ),
    )
    
    @property
    def url(self) -> str:
        """Construct the database URL from components.

        Credentials are percent-encoded: reserved URL characters in the
        user or password (@, :, /, %) would otherwise break the URL.
        """
        return (
            f"postgresql+asyncpg://{quote(self.user, safe='')}:"
            f"{quote(self.password.get_secret_value(), safe='')}"
            f"@{self.host}:{self.port}/{self.database}"
        )

    @property
    def asyncpg_dsn(self) -> str:
        """The connection URL as a plain postgresql:// DSN.

        AsyncPgChannelsBackend hands the DSN straight to asyncpg, which does
        not understand SQLAlchemy's +asyncpg driver suffix.
        """
        return self.url.replace("postgresql+asyncpg://", "postgresql://", 1)

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
        env_prefix="GEOIP_", env_file=_env_file(), extra="ignore", populate_by_name=True
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

    model_config = SettingsConfigDict(env_prefix="API_", env_file=_env_file(), extra="ignore")

    host: str = Field(default="0.0.0.0", description="API server host")
    port: int = Field(default=8000, description="API server port")
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] | None = Field(
        default=None,
        description="DEPRECATED: use LOG_LEVEL. Kept as a fallback for existing deployments.",
    )


class LogSettings(BaseSettings):
    """Application logging configuration (files, rotation, level)."""

    model_config = SettingsConfigDict(env_prefix="LOG_", env_file=_env_file(), extra="ignore")

    dir: Path = Field(default=Path("logs"), description="Directory for application log files")
    level: Literal["DEBUG", "INFO", "SUCCESS", "WARNING", "ERROR", "CRITICAL"] | None = Field(
        default=None,
        description="Root log level. Falls back to deprecated API_LOG_LEVEL, then INFO.",
    )
    main_max_bytes: int = Field(
        default=10 * 1024 * 1024,
        description="Rotate the main JSONL log when it exceeds this size (bytes)",
    )
    main_backup_count: int = Field(
        default=5, description="Number of gzipped main-log archives to keep"
    )
    login_max_bytes: int = Field(
        default=10 * 1024 * 1024,
        description="Rotate the login log when it exceeds this size (bytes)",
    )
    login_backup_count: int = Field(
        default=5, description="Number of gzipped login-log archives to keep"
    )


class LogParserSettings(BaseSettings):
    """Log parser configuration settings."""

    model_config = SettingsConfigDict(env_prefix="LOGPARSER_", env_file=_env_file(), extra="ignore")

    enabled: bool = Field(
        default=True,
        description="Enable log parser ingestion service"
    )
    log_paths: Annotated[list[Path], NoDecode] = Field(
        default_factory=lambda: [Path("/var/log/access/access.log")],
        min_length=1,
        description=(
            "Access log files to tail. Env accepts a single path or a JSON "
            "list of paths. Default: /var/log/access/access.log"
        ),
    )
    log_formats: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["auto"],
        description=(
            "Log format per tailed file: 'auto' (default, detected from the "
            "file's content), 'nginx', or 'traefik-json'. Env accepts a single "
            "value applied to every path, or a JSON list matching "
            "LOGPARSER_LOG_PATHS by position."
        ),
    )
    poll_interval: float = Field(
        default=1.0,
        description="Interval in seconds to poll the log file for new entries",
    )
    send_logs: bool = Field(default=True, description="Send parsed logs to the database")
    host_name: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: [socket.gethostname()],
        min_length=1,
        description=(
            "Source hostname stamped on ingested records. Env accepts a "
            "single value applied to every tailed file, or a JSON list "
            "matching LOGPARSER_LOG_PATHS by position. Default: this "
            "machine's hostname."
        ),
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
    ignore_ips: Annotated[list[str], NoDecode] = Field(
        default_factory=list,
        description=(
            "IPs/CIDRs the parser drops entirely (no geo event, access log, "
            "or debug row). Use for your own traffic hitting the reverse "
            "proxy. Env accepts one value, comma-separated values, or a "
            "JSON list. Empty (default): nothing is ignored."
        ),
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

    @field_validator("log_formats", mode="before")
    @classmethod
    def parse_log_formats(cls, value: object) -> object:
        """Accept a single format name or a JSON list of names."""
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith("["):
                return json.loads(stripped)
            return [stripped]
        return value

    @model_validator(mode="after")
    def validate_log_formats(self) -> "LogParserSettings":
        """Reject unknown format names and lengths that cannot map to log_paths."""
        from geometrikks.services.logparser.formats import FORMATS

        allowed = {"auto", *FORMATS}
        unknown = [f for f in self.log_formats if f not in allowed]
        if unknown:
            raise ValueError(f"Unknown log format(s) {unknown}; allowed: {sorted(allowed)}")
        if len(self.log_formats) not in (1, len(self.log_paths)):
            raise ValueError(
                "LOGPARSER_LOG_FORMATS must be one value or match "
                f"LOGPARSER_LOG_PATHS in length ({len(self.log_paths)})"
            )
        return self

    def resolved_formats(self) -> list[str]:
        """Return one format per log path.

        Returns:
            The configured formats, fanning a single value out across all
            log paths when only one value was provided.
        """
        if len(self.log_formats) == 1:
            return self.log_formats * len(self.log_paths)
        return list(self.log_formats)

    @field_validator("host_name", mode="before")
    @classmethod
    def parse_host_name(cls, value: object) -> object:
        """Accept a single hostname or a JSON list of hostnames."""
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith("["):
                return json.loads(stripped)
            return [stripped]
        return value

    @field_validator("host_name")
    @classmethod
    def validate_host_name_entries(cls, value: list[str]) -> list[str]:
        """Fail at startup on empty entries; '' would silently un-stamp records."""
        if any(not entry.strip() for entry in value):
            raise ValueError("LOGPARSER_HOST_NAME entries must be non-empty")
        return [entry.strip() for entry in value]

    @model_validator(mode="after")
    def validate_host_name_length(self) -> "LogParserSettings":
        """Reject hostname list lengths that cannot map to log_paths."""
        if len(self.host_name) not in (1, len(self.log_paths)):
            raise ValueError(
                "LOGPARSER_HOST_NAME must be one value or match "
                f"LOGPARSER_LOG_PATHS in length ({len(self.log_paths)})"
            )
        return self

    def resolved_hostnames(self) -> list[str]:
        """Return one hostname per log path.

        Returns:
            The configured hostnames, fanning a single value out across all
            log paths when only one value was provided.
        """
        if len(self.host_name) == 1:
            return self.host_name * len(self.log_paths)
        return list(self.host_name)

    @field_validator("ignore_ips", mode="before")
    @classmethod
    def parse_ignore_ips(cls, value: object) -> object:
        """Accept one value, comma-separated values, or a JSON list."""
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return []
            if stripped.startswith("["):
                return json.loads(stripped)
            return [part.strip() for part in stripped.split(",") if part.strip()]
        return value

    @field_validator("ignore_ips")
    @classmethod
    def validate_ignore_ips(cls, value: list[str]) -> list[str]:
        """Fail at startup on entries that are not an IP or CIDR."""
        for entry in value:
            try:
                ip_network(entry, strict=False)
            except ValueError as exc:
                raise ValueError(
                    f"LOGPARSER_IGNORE_IPS entry {entry!r} is not an IP address or CIDR"
                ) from exc
        return value


class AnalyticsSettings(BaseSettings):
    """Analytics and aggregation configuration settings.

    TimescaleDB handles retention via policies configured in lifecycle.py.
    These settings define the default retention periods.
    """

    model_config = SettingsConfigDict(env_prefix="ANALYTICS_", env_file=_env_file(), extra="ignore")

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



class SchedulerSettings(BaseSettings):
    """APScheduler configuration for periodic background tasks."""

    model_config = SettingsConfigDict(env_prefix="SCHEDULER_", env_file=_env_file(), extra="ignore")

    enabled: bool = Field(
        default=True,
        description="Enable scheduled background tasks",
    )
    location_refresh_interval_minutes: int = Field(
        default=10,
        description="Minutes between GeoLocation.last_hit refresh jobs",
    )


class MapSettings(BaseSettings):
    """Map presentation settings shared with the web client."""

    model_config = SettingsConfigDict(env_prefix="MAP_", env_file=_env_file(), extra="ignore")

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


class CrowdSecSettings(BaseSettings):
    """CrowdSec Local API integration settings.

    The integration is enabled when ``lapi_url`` and ``bouncer_api_key`` are
    set. The bouncer API key enables read-only decision access; machine
    credentials additionally enable ban/unban actions.
    """

    model_config = SettingsConfigDict(env_prefix="CROWDSEC_", env_file=_env_file(), extra="ignore")

    lapi_url: str | None = Field(
        default=None,
        description="CrowdSec Local API base URL, e.g. http://crowdsec:8080",
    )
    bouncer_api_key: SecretStr | None = Field(
        default=None,
        description="Bouncer API key (cscli bouncers add geometrikks) - read access",
    )
    machine_id: str | None = Field(
        default=None,
        description="Machine ID (cscli machines add) - enables ban/unban",
    )
    machine_password: SecretStr | None = Field(
        default=None,
        description="Machine password - enables ban/unban",
    )
    default_ban_duration: str = Field(
        default="4h",
        description="Default duration for manual bans (Go duration string)",
    )
    request_timeout: float = Field(default=10.0, description="LAPI request timeout in seconds")
    verify_tls: bool = Field(default=True, description="Verify TLS when LAPI uses https")
    stream_poll_interval: float = Field(
        default=15.0,
        gt=0,
        description="Seconds between decision-stream polls feeding live ban/unban updates",
    )

    @property
    def enabled(self) -> bool:
        """Read access is available: LAPI URL and bouncer key are both set."""
        return self.lapi_url is not None and self.bouncer_api_key is not None

    @property
    def write_enabled(self) -> bool:
        """Ban/unban is available: read access plus machine credentials."""
        return self.enabled and self.machine_id is not None and self.machine_password is not None

    @model_validator(mode="after")
    def validate_machine_credential_pair(self) -> "CrowdSecSettings":
        """Require both machine credentials or neither.

        Half-configured write credentials should fail at startup, not at the
        first ban attempt.
        """
        if (self.machine_id is None) != (self.machine_password is None):
            raise ValueError(
                "CROWDSEC_MACHINE_ID and CROWDSEC_MACHINE_PASSWORD must be set together"
            )
        return self


class ViteSettings(BaseSettings):
    """Vite server configuration settings."""

    model_config = SettingsConfigDict(env_prefix="VITE_", env_file=_env_file(), extra="ignore")

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


class AppSettings(BaseSettings):
    """Application-level settings."""

    model_config = SettingsConfigDict(env_prefix="APP_", env_file=_env_file(), extra="ignore")

    mode: Literal["full", "agent"] = Field(
        default="full",
        description="Application mode: full (all components) or agent (logparser only)"
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
        env_file=_env_file(),
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
    session_secure: bool = Field(
        default=False,
        description=(
            "Mark the session cookie Secure so browsers only send it over "
            "HTTPS. Recommended when serving behind a TLS reverse proxy."
        ),
    )
    trusted_proxies: Annotated[list[str], NoDecode] = Field(
        default_factory=list,
        description=(
            "Reverse-proxy IPs/CIDRs allowed to supply X-Forwarded-For. Env "
            "accepts one value, comma-separated values, or a JSON list. "
            "Empty (default): forwarded headers are never trusted."
        ),
    )

    @field_validator("trusted_proxies", mode="before")
    @classmethod
    def parse_trusted_proxies(cls, value: object) -> object:
        """Accept one value, comma-separated values, or a JSON list."""
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return []
            if stripped.startswith("["):
                return json.loads(stripped)
            return [part.strip() for part in stripped.split(",") if part.strip()]
        return value

    @field_validator("trusted_proxies")
    @classmethod
    def validate_trusted_proxies(cls, value: list[str]) -> list[str]:
        """Fail at startup on entries that are not an IP or CIDR."""
        for entry in value:
            try:
                ip_network(entry, strict=False)
            except ValueError as exc:
                raise ValueError(
                    f"APP_TRUSTED_PROXIES entry {entry!r} is not an IP address or CIDR"
                ) from exc
        return value

    @model_validator(mode="after")
    def _resolve_log_level(self) -> "Settings":
        """LOG_LEVEL wins; deprecated API_LOG_LEVEL is honored with a warning."""
        if self.log.level is None:
            if self.api.log_level is not None:
                warnings.warn(
                    "API_LOG_LEVEL is deprecated and will be removed in a future "
                    "release; set LOG_LEVEL instead.",
                    DeprecationWarning,
                    stacklevel=2,
                )
                self.log.level = self.api.log_level
            else:
                self.log.level = "INFO"
        return self

    # Sub-configurations
    app: AppSettings = Field(default_factory=AppSettings)
    api: APISettings = Field(default_factory=APISettings)
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
    geoip: GeoIPSettings = Field(default_factory=GeoIPSettings)
    log: LogSettings = Field(default_factory=LogSettings)
    logparser: LogParserSettings = Field(default_factory=LogParserSettings)
    analytics: AnalyticsSettings = Field(default_factory=AnalyticsSettings)
    scheduler: SchedulerSettings = Field(default_factory=SchedulerSettings)
    map: MapSettings = Field(default_factory=MapSettings)
    crowdsec: CrowdSecSettings = Field(default_factory=CrowdSecSettings)
    vite: ViteSettings = Field(default_factory=ViteSettings)

    @model_validator(mode="after")
    def validate_agent_tails_something(self) -> "Settings":
        """APP_MODE=agent with LOGPARSER_ENABLED=false is a no-op process."""
        if self.app.mode == "agent" and not self.logparser.enabled:
            raise ValueError(
                "APP_MODE=agent requires LOGPARSER_ENABLED=true: an agent "
                "that tails nothing does nothing"
            )
        return self

    @property
    def is_agent(self) -> bool:
        """Check if running in agent mode."""
        return self.app.mode == "agent"

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
