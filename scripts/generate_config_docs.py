"""Generate the configuration page of the docs site from pydantic-settings field metadata.

The settings classes carry description= on every field; this script turns
them into site/content/docs/next/reference/configuration.mdx, so the docs
can't drift from code.

Usage:
    uv run python scripts/generate_config_docs.py          # write the file
    uv run python scripts/generate_config_docs.py --check  # CI freshness gate
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Literal

from pydantic.fields import FieldInfo
from pydantic_settings import BaseSettings, NoDecode

# Running this file directly (not via `python -m`) puts scripts/ on sys.path
# instead of the repo root, so the geometrikks package import below would
# fail. Insert the repo root explicitly.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Import via the package so nested settings classes resolve.
from geometrikks.config import settings as settings_module  # noqa: E402

SITE_OUTPUT = REPO_ROOT / "site" / "content" / "docs" / "next" / "reference" / "configuration.mdx"

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
    ("DROP lists", settings_module.DropSettings, "DROP_"),
    ("AbuseIPDB", settings_module.AbuseIpdbSettings, "ABUSEIPDB_"),
    ("OpenID Connect", settings_module.OidcSettings, "OIDC_"),
    ("Instance and notices", settings_module.AppSettings, "APP_"),
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
    "map", "crowdsec", "drop", "abuseipdb", "oidc", "vite",
}
# Defaults that differ per machine, so the page names them instead.
DEFAULT_LABELS: dict[tuple[type[BaseSettings], str], str] = {
    (settings_module.LogParserSettings, "server_name"): "*(the machine's hostname)*",
}
# Never document secrets' defaults verbatim.
REDACT = {
    "password", "license_key", "admin_password", "bouncer_api_key", "machine_password",
    "client_secret",
}

# (name, default as rendered, description): read by the image and the shipped
# compose file, not by the settings classes.
CONTAINER_VARIABLES: list[tuple[str, str, str]] = [
    (
        "PUID",
        "`1000`",
        "User id the app runs as. At startup the entrypoint remaps the `geometrikks` user to "
        "it, chowns `/app`, `/app/logs` and `/app/data/geoip` to `PUID:PGID`, then drops root. "
        "Match your host user (`id -u`) so host tools can manage the files in `./logs`. "
        "A non-root `user:` on the `app` service skips the remap and every chown. That user "
        "must then own `./logs` and the geoip volume, or GeoLite2 downloads fail. It must also "
        "be able to write to `/app`, which UID 1000 owns in the image. In `full` mode the app "
        "rewrites `/app/.litestar.json` through a temporary file in `/app` at startup, so "
        "without that access startup stops with a PermissionError.",
    ),
    (
        "PGID",
        "`1000`",
        "Group id the app runs as. At startup the entrypoint remaps the `geometrikks` group to "
        "it and chowns `/app`, `/app/logs` and `/app/data/geoip` to `PUID:PGID`. Match your "
        "host group (`id -g`). A non-root `user:` on the `app` service skips this remap too. "
        "See `PUID` for what that user then needs.",
    ),
    (
        "ACCESS_LOG_DIR",
        "`/var/log/nginx`",
        "Host folder the compose file mounts read-only at `/var/log/access`, where "
        "`LOGPARSER_LOG_PATHS` points by default. Set it to the folder that holds your "
        "proxy's access logs.",
    ),
    (
        "NGINX_LOG_DIR",
        "-",
        "Older name for `ACCESS_LOG_DIR`. The compose file uses it only when `ACCESS_LOG_DIR` "
        "is unset.",
    ),
    (
        "POSTGRES_USER",
        "`geouser`",
        "Database user the `timescale_db` service creates. The compose file sets it on that "
        "service, so a value in `.env` changes nothing. It must match `DB_USER`. Postgres "
        "reads it only when it creates the data volume.",
    ),
    (
        "POSTGRES_PASSWORD",
        "`DB_PASSWORD`, else `geopass`",
        "Password of the database user. The compose file sets it to `${DB_PASSWORD:-geopass}` "
        "and sets the app's `DB_PASSWORD` the same way, so both fall back to `geopass` when "
        "`DB_PASSWORD` is unset. Postgres applies it only when it creates the "
        "data volume. Changing `DB_PASSWORD` later locks the app out of the database until "
        "you also change the password inside Postgres with `ALTER USER geouser PASSWORD '...'`.",
    ),
    (
        "POSTGRES_DB",
        "`geometrikks`",
        "Database the `timescale_db` service creates. The compose file sets it on that "
        "service, so a value in `.env` changes nothing. It must match `DB_DATABASE`. Postgres "
        "reads it only when it creates the data volume.",
    ),
    (
        "LITESTAR_WEB_CONCURRENCY",
        "`1`",
        "Worker count for `litestar run`. The image's command passes `--workers 1`, which wins "
        "over this and the two variables below, so they change nothing in the container. "
        "Outside the image, every worker runs the whole app. Each one tails every log, so "
        "each line is stored once per worker, and runs every scheduled job. Each process "
        "runs its own `/ws/crowdsec` and `/ws/logs` feeds and keeps its own session lock, "
        "so logins and logouts on different workers can race. Two processes can also run "
        "migrations at once. "
        "See [Deployment](deployment.md).",
    ),
    (
        "WEB_CONCURRENCY",
        "`1`",
        "Same as `LITESTAR_WEB_CONCURRENCY`, which wins when both are set.",
    ),
    (
        "GRANIAN_WORKERS",
        "`1`",
        "Same as `LITESTAR_WEB_CONCURRENCY`, read only when neither it nor `WEB_CONCURRENCY` "
        "is set.",
    ),
    (
        "LITESTAR_APP",
        "*(set by the image)*",
        "Tells `litestar` CLI commands where the app is. The image sets it to "
        "`geometrikks.server.core:create_app`, so commands run in the container need no "
        "`--app`. Outside the image, pass `--app geometrikks.server.core:create_app`.",
    ),
]

SECTION_NOTES: dict[str, list[str]] = {
    "OpenID Connect": [
        "Login with OpenID Connect turns on when `OIDC_ISSUER`, `OIDC_CLIENT_ID`,",
        "`OIDC_CLIENT_SECRET` and `OIDC_REDIRECT_URI` are all set. Setting only some of",
        "them stops startup with an error that names the missing ones. Startup also fails when:",
        "",
        "- `OIDC_ISSUER` or `OIDC_REDIRECT_URI` uses plain http on a host other than localhost or a loopback IP address.",
        "- `OIDC_ISSUER` or `OIDC_REDIRECT_URI` carries credentials, a query string or a fragment.",
        "- The path of `OIDC_REDIRECT_URI` is not `/api/v1/auth/oidc/callback`.",
        "- Neither `OIDC_ALLOWED_USERS` nor `OIDC_ALLOWED_GROUPS` is set.",
        "- `OIDC_SCOPES` does not include `openid`.",
        "- `OIDC_CA_BUNDLE` names a file that is missing or unreadable.",
        "- `APP_AUTH_DISABLED=true` is set.",
        "- `OIDC_REDIRECT_URI` is https and `APP_SESSION_SECURE` is not `true`.",
    ],
}

# Links in descriptions name the keys below; the site page swaps in their
# targets and drops the link while its page does not exist yet, so the site's
# dead-link check passes. Adding the page makes --check report the file stale.
SITE_LINKS = {"deployment.md": "../operate/deployment.mdx"}


def accepts_single_value(field: FieldInfo) -> bool:
    # NoDecode fields go through the settings' own parser, which takes one bare
    # value; other lists are JSON-decoded, so `en` fails where `["en"]` works.
    return NoDecode in field.metadata


def format_default(default: object, field: FieldInfo) -> str:
    if default is None:
        return "-"
    if default in ("", [], {}):
        return "*(empty)*"
    # These render as env-var values, so use env-native forms: lowercase
    # booleans and JSON arrays/objects rather than Python repr.
    if isinstance(default, bool):
        return f"`{str(default).lower()}`"
    if isinstance(default, list) and len(default) == 1 and accepts_single_value(field):
        return format_default(default[0], field)
    if isinstance(default, (list, dict)):
        return f"`{json.dumps(default, default=str)}`"
    return f"`{default}`"


def default_repr(cls: type[BaseSettings], name: str, field: FieldInfo) -> str:
    if name in REDACT:
        return "-"
    if (cls, name) in DEFAULT_LABELS:
        return DEFAULT_LABELS[(cls, name)]
    if field.default_factory_takes_validated_data:
        raise TypeError(f"{cls.__name__}.{name}: add a DEFAULT_LABELS entry for its default")
    return format_default(field.get_default(call_default_factory=True), field)


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


def row(name: str, default: str, description: str) -> str:
    escaped = description.replace("|", "\\|")
    return f"| `{name}` | {default} | {escaped} |"


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
        lines.append(row(env_name(name, field, prefix), default_repr(cls, name, field), field.description or ""))
    return lines


def render_group(
    title: str, intro: list[str], sections: list[tuple[str, type[BaseSettings], str]]
) -> str:
    parts = [f"## {title}", "", *intro, ""]
    for section_title, cls, prefix in sections:
        section_rows = rows(cls, prefix, tier="regular")
        if section_rows:
            parts += [f"### {section_title}", ""]
            if note := SECTION_NOTES.get(section_title):
                parts += [*note, ""]
            parts += [*TABLE_HEADER, *section_rows, ""]
    return "\n".join(parts)


def render_tier_table(title: str, intro: list[str], tier: Tier) -> str:
    tier_rows = [tier_row for _title, cls, prefix in SECTIONS for tier_row in rows(cls, prefix, tier=tier)]
    if tier == "developer":
        for cls, prefix in DEVELOPER_SECTIONS:
            tier_rows += rows(cls, prefix, tier=None)
    return "\n".join([f"## {title}", "", *intro, "", *TABLE_HEADER, *tier_rows, ""])


def render_container_variables() -> str:
    container_rows = [row(name, default, description) for name, default, description in CONTAINER_VARIABLES]
    intro = (
        "The image and the shipped `docker-compose.yml` read these. They are not app "
        "settings, so Settings > Environment does not list them."
    )
    return "\n".join(["## Container and compose variables", "", intro, "", *TABLE_HEADER, *container_rows, ""])


def body() -> str:
    parts = [
        "All settings are environment variables (or `.env` entries). The short",
        "list most users need is in `.env.example`. This page lists every variable.",
        "",
        "The variables come in five groups:",
        "",
        "- Essentials: login, database, the logs to read and GeoIP.",
        "- Container and compose variables: read by the image and the compose file, not by the app.",
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
        render_container_variables(),
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


# Code spans stay on one line, and a span opens only at the start of a backtick
# run: otherwise the second tick of an empty `` would open a span that swallows
# the text up to the next code span and leaves that span's braces escaped.
_CODE_SPAN_OR_MDX_SPECIAL = re.compile(r"(?<!`)(`+)[^`\n][^\n]*?(?<!`)\1(?!`)|[{}<]")
_MARKDOWN_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")


def site_links(text: str) -> str:
    """Point docs/ links at their site pages, or keep only the label while a page is missing."""

    def replace(match: re.Match[str]) -> str:
        label, target = match.groups()
        site_target = SITE_LINKS.get(target)
        if site_target is None:
            raise ValueError(f"add a SITE_LINKS entry for {target}")
        if not (SITE_OUTPUT.parent / site_target).is_file():
            return label
        return f"[{label}]({site_target})"

    return _MARKDOWN_LINK.sub(replace, text)


def escape_mdx(text: str) -> str:
    """Backslash-escape `{`, `}` and `<` outside backtick code spans."""
    return _CODE_SPAN_OR_MDX_SPECIAL.sub(
        lambda match: match.group(0) if match.group(1) else "\\" + match.group(0), text
    )


def build_site() -> str:
    return (
        "---\n"
        "title: Configuration\n"
        "description: Every environment variable GeoMetrikks reads, generated from the settings classes.\n"
        "---\n\n"
        "{/* GENERATED by scripts/generate_config_docs.py; do not edit by hand. */}\n\n"
        + escape_mdx(site_links(body()))
    )


def main() -> int:
    content = build_site()
    if "--check" in sys.argv:
        if not SITE_OUTPUT.exists() or SITE_OUTPUT.read_text(encoding="utf-8") != content:
            print(f"{SITE_OUTPUT} is stale; run scripts/generate_config_docs.py", file=sys.stderr)
            return 1
        return 0
    SITE_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    SITE_OUTPUT.write_text(content, encoding="utf-8")
    print(f"wrote {SITE_OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
