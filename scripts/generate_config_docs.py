"""Generate docs/configuration.md from pydantic-settings field metadata.

The settings classes carry description= on every field; this script turns
them into the full configuration reference so docs can't drift from code.

Usage:
    uv run python scripts/generate_config_docs.py          # write the file
    uv run python scripts/generate_config_docs.py --check  # CI freshness gate
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings

# Running this file directly (not via `python -m`) puts scripts/ on sys.path
# instead of the repo root, so the geometrikks package import below would
# fail. Insert the repo root explicitly.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Import via the package so nested settings classes resolve.
from geometrikks.config import settings as settings_module  # noqa: E402

OUTPUT = REPO_ROOT / "docs" / "configuration.md"

# (title, class, env prefix); order defines document order.
ESSENTIAL_SECTIONS: list[tuple[str, type[BaseSettings], str]] = [
    ("Application", settings_module.Settings, "APP_"),
    ("Database", settings_module.DatabaseSettings, "DB_"),
    ("Log parser", settings_module.LogParserSettings, "LOGPARSER_"),
    ("GeoIP", settings_module.GeoIPSettings, "GEOIP_"),
]
OPTIONAL_SECTIONS: list[tuple[str, type[BaseSettings], str]] = [
    ("Loki", settings_module.LokiSettings, "LOKI_"),
    ("Map", settings_module.MapSettings, "MAP_"),
    ("CrowdSec", settings_module.CrowdSecSettings, "CROWDSEC_"),
    ("OpenID Connect", settings_module.OidcSettings, "OIDC_"),
    ("Application mode", settings_module.AppSettings, "APP_"),
    ("Analytics & retention", settings_module.AnalyticsSettings, "ANALYTICS_"),
    ("Logging", settings_module.LogSettings, "LOG_"),
    ("Scheduler", settings_module.SchedulerSettings, "SCHEDULER_"),
]
SECTIONS = ESSENTIAL_SECTIONS + OPTIONAL_SECTIONS
# Every field here is a developer setting, tagged or not.
DEVELOPER_SECTIONS: list[tuple[type[BaseSettings], str]] = [
    (settings_module.ViteSettings, "VITE_"),
]

# Top-level Settings fields that are sub-models, not env vars.
SKIP_FIELDS = {
    "app", "database", "geoip", "log", "logparser", "loki", "analytics", "scheduler",
    "map", "crowdsec", "oidc", "vite",
}
# Never document secrets' defaults verbatim.
REDACT = {
    "password", "license_key", "admin_password", "bouncer_api_key", "machine_password",
    "client_secret",
}


def default_repr(name: str, field) -> str:
    if name in REDACT:
        return "-"
    if field.default_factory is not None:
        return "*(computed)*"
    default = field.default
    if default is None:
        return "-"
    # These render as env-var values, so use env-native forms: lowercase
    # booleans and JSON arrays/objects rather than Python repr.
    if isinstance(default, bool):
        return f"`{str(default).lower()}`"
    if isinstance(default, (list, dict)):
        return f"`{json.dumps(default)}`"
    return f"`{default}`"


def env_name(name: str, field, prefix: str) -> str:
    # A string validation_alias is absolute: it bypasses env_prefix.
    # (GeoIPSettings.account_id/license_key -> MAXMINDDB_USER_ID/MAXMINDDB_LICENSE_KEY.)
    alias = field.validation_alias
    if isinstance(alias, str):
        return alias
    return f"{prefix}{name}".upper()


TABLE_HEADER = ["| Variable | Default | Description |", "|---|---|---|"]


Tier = Literal["regular", "advanced", "developer"]


def field_tier(field) -> Tier:
    if settings_module.is_developer_field(field.json_schema_extra):
        return "developer"
    if settings_module.is_advanced_field(field.json_schema_extra):
        return "advanced"
    return "regular"


def rows(cls: type[BaseSettings], prefix: str, *, tier: Tier | None) -> list[str]:
    """Table rows for one tier; tier=None keeps every field."""
    lines = []
    for name, field in cls.model_fields.items():
        if cls is settings_module.Settings and name in SKIP_FIELDS:
            continue
        if settings_module.is_legacy_field(field.json_schema_extra):
            continue
        if tier is not None and field_tier(field) != tier:
            continue
        env = env_name(name, field, prefix)
        desc = (field.description or "").replace("|", "\\|")
        lines.append(f"| `{env}` | {default_repr(name, field)} | {desc} |")
    return lines


def render_group(
    title: str, intro: list[str], sections: list[tuple[str, type[BaseSettings], str]]
) -> str:
    parts = [f"## {title}", "", *intro, ""]
    for section_title, cls, prefix in sections:
        section_rows = rows(cls, prefix, tier="regular")
        if section_rows:
            parts += [f"### {section_title}", "", *TABLE_HEADER, *section_rows, ""]
    return "\n".join(parts)


def render_tier_table(title: str, intro: list[str], tier: Tier) -> str:
    tier_rows = [row for _title, cls, prefix in SECTIONS for row in rows(cls, prefix, tier=tier)]
    if tier == "developer":
        for cls, prefix in DEVELOPER_SECTIONS:
            tier_rows += rows(cls, prefix, tier=None)
    return "\n".join([f"## {title}", "", *intro, "", *TABLE_HEADER, *tier_rows, ""])


def build() -> str:
    parts = [
        "# Configuration Reference",
        "",
        "<!-- GENERATED by scripts/generate_config_docs.py; do not edit by hand. -->",
        "",
        "All settings are environment variables (or `.env` entries). The short",
        "list most users need is in `.env.example`. This page lists every variable.",
        "",
        "The variables come in four groups:",
        "",
        "- Essentials: login, database, the logs to read and GeoIP.",
        "- Optional settings: one subsection per feature. Skip the ones you don't use.",
        "- Advanced tuning: pool sizes, poll intervals, timeouts and log rotation.",
        "  The defaults fit almost every install.",
        "- Developer settings: for working on GeoMetrikks itself.",
        "",
        "`GEOMETRIKKS_ENV_FILE` overrides the path of the `.env` file itself",
        "(default: `.env` in the working directory); setting it to an empty",
        "value disables dotenv loading entirely, so configuration comes only",
        "from real environment variables. It is read once at import time.",
        "",
        render_group(
            "Essentials",
            ["Most installs set these. The compose file sets `DB_HOST` for you."],
            ESSENTIAL_SECTIONS,
        ),
        render_group(
            "Optional settings",
            ["Set these only for a feature you use, or to change a default."],
            OPTIONAL_SECTIONS,
        ),
        render_tier_table(
            "Advanced tuning",
            [
                "Change these only to fix a problem you have measured, such as a",
                "connection pool that runs dry or a log that rotates too often.",
            ],
            "advanced",
        ),
        render_tier_table(
            "Developer settings",
            [
                "For working on GeoMetrikks itself. Deployments leave these at their",
                "defaults. The container image sets `APP_RUNTIME` and `APP_IMAGE_TAG` itself.",
            ],
            "developer",
        ),
    ]
    return "\n".join(parts) + "\n"


def main() -> int:
    content = build()
    if "--check" in sys.argv:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != content:
            print(f"{OUTPUT} is stale; run scripts/generate_config_docs.py", file=sys.stderr)
            return 1
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(content, encoding="utf-8")
    print(f"wrote {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
