import os
import pytest


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
        "APP_VERSION": "0.1.0",
        "APP_DEBUG": "false",
        "APP_ENVIRONMENT": "development",
        # API
        "API_HOST": "0.0.0.0",
        "API_PORT": "8000",
        "API_WORKERS": "1",
        "API_RELOAD": "false",
        "API_LOG_LEVEL": "info",
        # Database
        "DB_URL": "postgresql+asyncpg://geouser:geopass@localhost:5432/geometrikks",
        "DB_ECHO": "false",
        "DB_POOL_SIZE": "5",
        "DB_MAX_OVERFLOW": "10",
        "DB_POOL_TIMEOUT": "30",
        "DB_POOL_RECYCLE": "3600",
        "DB_DROP_ON_STARTUP": "false",
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
