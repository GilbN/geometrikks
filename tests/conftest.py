import os
import pytest

# Tests must never read a developer's .env. Every settings section resolves
# its dotenv path through GEOMETRIKKS_ENV_FILE at class-creation time (empty
# disables it), so this must run before geometrikks.config.settings is
# imported anywhere; conftest module import precedes test collection.
os.environ["GEOMETRIKKS_ENV_FILE"] = ""

# The app's entire configuration namespace is scrubbed from the inherited
# environment for the same reason: a developer shell exporting perfectly
# valid values (SCHEDULER_ENABLED=false, CROWDSEC_MACHINE_ID=..., MAP_HOME_*)
# must not change test results. Values tests do rely on are re-set in
# baseline_settings_env below; tests needing others use monkeypatch.setenv.
_SETTINGS_ENV_PREFIXES = (
    "APP_", "API_", "DB_", "GEOIP_", "LOG_", "LOGPARSER_", "ANALYTICS_",
    "SCHEDULER_", "MAP_", "CROWDSEC_", "VITE_", "MAXMINDDB_",
)
for _key in [k for k in os.environ if k.startswith(_SETTINGS_ENV_PREFIXES)]:
    del os.environ[_key]


@pytest.fixture
def anyio_backend() -> str:
    """Async tests run on asyncio; Litestar's runtime is AnyIO-based."""
    return "asyncio"


@pytest.fixture(scope="session", autouse=True)
def disable_wait_env():
    """Ensure retry loops are disabled during test runs.

    Sets DISABLE_WAIT=true for the entire pytest session so retry loops
    (log-file existence, log-format validation) run once and return
    immediately, preventing slow/hanging tests. Tests that exercise the
    retry behaviour itself opt back in with monkeypatch.
    """
    os.environ["DISABLE_WAIT"] = "true"


@pytest.fixture(scope="session", autouse=True)
def baseline_settings_env():
    """Provide baseline env vars so tests are not affected by local .env.

    Pydantic-settings precedence: init args > env vars > .env > defaults.
    Setting these ensures stable defaults regardless of any .env present.
    """
    os.environ.update({
        # App
        "APP_NAME": "GeoMetrikks API",
        "APP_DEBUG": "false",
        "APP_ENVIRONMENT": "production",
        # API
        "API_HOST": "0.0.0.0",
        "API_PORT": "8000",
        "LOG_LEVEL": "INFO",
        # Database
        "DB_ECHO": "false",
        "DB_POOL_SIZE": "5",
        "DB_MAX_OVERFLOW": "10",
        "DB_POOL_TIMEOUT": "30",
        "DB_POOL_RECYCLE": "3600",
        "DB_DROP_ON_STARTUP": "false",
        # Auth
        "APP_AUTH_DISABLED": "false",
        # GeoIP
        "GEOIP_DB_PATH": "tests/GeoLite2-City-Test.mmdb",
        # Map (tests must never depend on an external public-IP service)
        "MAP_AUTO_DETECT_HOME": "false",
        # Log parser
        "LOGPARSER_LOG_PATHS": "/var/log/access/access.log",
    })


@pytest.fixture(autouse=True)
def refresh_settings_cache():
    """Clear settings cache so env changes take effect per test.

    Ensures tests using monkeypatch.setenv() get a fresh Settings instance.
    """
    from geometrikks.config.settings import get_settings
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
