"""docs/configuration.md must match the settings classes (generated file)."""
import subprocess
import sys


def test_configuration_docs_are_fresh():
    result = subprocess.run(
        [sys.executable, "scripts/generate_config_docs.py", "--check"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr


def test_developer_settings_are_listed_only_in_their_own_section():
    from pathlib import Path

    text = Path("docs/configuration.md").read_text(encoding="utf-8")
    regular, developer = text.split("## Developer settings", 1)
    for env_var in ("APP_DEBUG", "DB_DROP_ON_STARTUP", "LOGPARSER_SKIP_VALIDATION", "VITE_DEV_MODE"):
        assert f"`{env_var}`" in developer
        assert f"`{env_var}`" not in regular
    assert "`DB_POOL_SIZE`" in regular
