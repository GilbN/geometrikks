import os
import pytest

# Tests must never read a developer's .env. Every settings section resolves
# its dotenv path through GEOMETRIKKS_ENV_FILE at class-creation time (empty
# disables it), so this must run before geometrikks.config.settings is
# imported anywhere; conftest module import precedes test collection.
os.environ["GEOMETRIKKS_ENV_FILE"] = ""


@pytest.fixture
def anyio_backend() -> str:
    """Async tests run on asyncio; Litestar's runtime is AnyIO-based."""
    return "asyncio"


@pytest.fixture(scope="session", autouse=True)
def disable_wait_env():
    """Ensure retry loops are disabled during test runs.

    Sets DISABLE_WAIT=true for the entire pytest session so any @wait-decorated
    functions run once and return immediately, preventing slow/hanging tests.
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
        "LOGPARSER_LOG_PATHS": "/var/log/nginx/access.log",
    })
    # Representative developer values that default-asserting tests are
    # sensitive to; scrub them so an exported shell environment cannot leak
    # into the suite. Tests that need them set them via monkeypatch.
    for var in ("MAP_HOME_LATITUDE", "MAP_HOME_LONGITUDE", "LOGPARSER_IGNORE_IPS"):
        os.environ.pop(var, None)


@pytest.fixture(autouse=True)
def refresh_settings_cache():
    """Clear settings cache so env changes take effect per test.

    Ensures tests using monkeypatch.setenv() get a fresh Settings instance.
    """
    from geometrikks.config.settings import get_settings
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
