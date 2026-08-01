"""Import-time safety: server modules must not construct settings/engine on import."""
import os
import subprocess
import sys


def test_server_imports_without_geoip_db() -> None:
    """Importing the app factory must succeed even when the GeoIP mmdb is missing.

    Settings construction (which validates the mmdb path) must happen inside
    create_app()/lifespan startup, never at import time. Runs in a subprocess so this
    test is immune to modules already imported by the test session."""
    env = os.environ | {
        "GEOIP_DB_PATH": "/nonexistent/GeoLite2-City.mmdb",
        "GEOIP_VALIDATE_DB_PATH": "true",
    }
    result = subprocess.run(
        [sys.executable, "-c", "import geometrikks.server.core, geometrikks.server.migrations"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, f"import failed:\n{result.stderr}"
