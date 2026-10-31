"""docs/configuration.md must match the settings classes (generated file)."""
import re
import subprocess
import sys
from pathlib import Path

from geometrikks.config import settings as settings_module


def _doc_groups() -> tuple[str, str, str]:
    text = Path("docs/configuration.md").read_text(encoding="utf-8")
    regular, rest = text.split("## Advanced tuning", 1)
    advanced, developer = rest.split("## Developer settings", 1)
    return regular, advanced, developer


def test_configuration_docs_are_fresh():
    result = subprocess.run(
        [sys.executable, "scripts/generate_config_docs.py", "--check"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr


def test_developer_settings_are_listed_only_in_their_own_section():
    regular, advanced, developer = _doc_groups()
    for env_var in ("APP_DEBUG", "DB_DROP_ON_STARTUP", "LOGPARSER_SKIP_VALIDATION", "VITE_DEV_MODE"):
        assert f"`{env_var}`" in developer
        assert f"`{env_var}`" not in regular + advanced


def test_advanced_settings_are_listed_only_in_their_own_section():
    regular, advanced, developer = _doc_groups()
    for env_var in ("DB_POOL_SIZE", "LOGPARSER_BATCH_SIZE", "LOG_MAIN_MAX_BYTES", "SCHEDULER_ENABLED"):
        assert f"`{env_var}`" in advanced
        assert f"`{env_var}`" not in regular + developer
    assert "`DB_PASSWORD`" in regular


def test_every_documented_variable_has_one_row():
    text = Path("docs/configuration.md").read_text(encoding="utf-8")
    documented = re.findall(r"^\| `([A-Z0-9_]+)` \|", text, flags=re.M)
    assert len(documented) == len(set(documented))


def test_no_field_is_both_advanced_and_developer():
    from pydantic_settings import BaseSettings

    for settings_class in vars(settings_module).values():
        if not (isinstance(settings_class, type) and issubclass(settings_class, BaseSettings)):
            continue
        for field_name, field in settings_class.model_fields.items():
            extra = field.json_schema_extra
            assert not (
                settings_module.is_advanced_field(extra) and settings_module.is_developer_field(extra)
            ), f"{settings_class.__name__}.{field_name}"
