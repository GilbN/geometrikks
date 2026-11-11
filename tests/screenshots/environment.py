"""Environment for the screenshot run: the scrub of its own process, each child's environment and preflight.

``__main__`` imports this module before anything reads settings, so it
imports nothing from ``geometrikks`` or ``tests.seed``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, MutableMapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.engine import make_url

SCRUB_PREFIXES: tuple[str, ...] = (
    "APP_",
    "DB_",
    "GEOIP_",
    "LOG_",
    "LOGPARSER_",
    "LOKI_",
    "ANALYTICS_",
    "SCHEDULER_",
    "MAP_",
    "CROWDSEC_",
    "DROP_",
    "OIDC_",
    "VITE_",
)
SCRUB_NAMES: frozenset[str] = frozenset(
    {
        "MAXMINDDB_USER_ID",
        "MAXMINDDB_LICENSE_KEY",
        "DISABLE_ROTATION_CHECK",
        "DISABLE_WAIT",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
    }
)
PASSTHROUGH: frozenset[str] = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "TERM",
        "UV_CACHE_DIR",
        "XDG_CACHE_HOME",
        "PLAYWRIGHT_BROWSERS_PATH",
        "BUN_INSTALL",
    }
)
ENV_FILE_VAR = "GEOMETRIKKS_ENV_FILE"
CARTO_VAR = "MAP_CARTO_API_KEY"
PG_ADMIN_VAR = "SHOTS_PG_ADMIN_URL"
MACHINE_ID = "geometrikks-shots"
MIN_MEMORY = 3 * 2**30
MIN_DISK = 10 * 10**9


@dataclass(frozen=True, slots=True)
class ShotInputs:
    carto_key: str | None
    pg_admin_url: str | None


def _scrubbed(name: str) -> bool:
    # pydantic-settings matches env names case-insensitively, and httpx reads both cases of the proxy names.
    upper = name.upper()
    return upper.startswith(SCRUB_PREFIXES) or upper in SCRUB_NAMES


def scrub_process_env(environ: MutableMapping[str, str]) -> ShotInputs:
    """Keep the explicit screenshot inputs, then delete every app setting and turn dotenv loading off."""
    inputs = ShotInputs(carto_key=environ.get(CARTO_VAR) or None, pg_admin_url=environ.get(PG_ADMIN_VAR) or None)
    for name in [name for name in environ if _scrubbed(name)]:
        del environ[name]
    environ[ENV_FILE_VAR] = ""
    return inputs


@dataclass(frozen=True, slots=True, kw_only=True)
class RunConfig:
    run_id: str
    pg_admin_url: str
    database: str = "geometrikks_screenshots"
    own_db: bool
    app_port: int
    bouncer_key: str
    machine_password: str
    city_db: Path
    asn_db: Path
    carto_key: str
    servers: tuple[str, ...] = ("edge", "homelab")
    live_dir: Path


def base_env(environ: Mapping[str, str]) -> dict[str, str]:
    env = {name: value for name, value in environ.items() if name in PASSTHROUGH}
    env[ENV_FILE_VAR] = ""
    return env


def database_url(config: RunConfig, *, driver: str = "postgresql+asyncpg") -> str:
    url = make_url(config.pg_admin_url).set(drivername=driver, database=config.database)
    return url.render_as_string(hide_password=False)


def app_env(
    environ: Mapping[str, str],
    config: RunConfig,
    *,
    lapi_url: str,
    log_targets: Sequence[tuple[str, str, Path]],
) -> dict[str, str]:
    admin = make_url(config.pg_admin_url)
    return {
        **base_env(environ),
        "DB_HOST": admin.host or "localhost",
        "DB_PORT": str(admin.port or 5432),
        "DB_USER": admin.username or "",
        "DB_PASSWORD": admin.password or "",
        "DB_DATABASE": config.database,
        "APP_ADMIN_USER": "admin",
        "APP_ADMIN_PASSWORD": "admin",
        "APP_AUTH_DISABLED": "false",
        "APP_UPDATE_CHECK": "false",
        "VITE_DEV_MODE": "false",
        "GEOIP_DB_PATH": str(config.city_db),
        "GEOIP_ASN_DB_PATH": str(config.asn_db),
        "MAP_AUTO_DETECT_SERVER_LOCATION": "false",
        "MAP_CARTO_API_KEY": config.carto_key,
        "LOGPARSER_ENABLED": "true",
        "LOGPARSER_LOG_PATHS": json.dumps([str(path) for _, _, path in log_targets]),
        "LOGPARSER_LOG_FORMATS": json.dumps([log_format for _, log_format, _ in log_targets]),
        "LOGPARSER_SERVER_NAME": json.dumps([server for server, _, _ in log_targets]),
        "LOGPARSER_COMMIT_INTERVAL": "1",
        "CROWDSEC_LAPI_URL": lapi_url,
        "CROWDSEC_BOUNCER_API_KEY": config.bouncer_key,
        "CROWDSEC_MACHINE_ID": MACHINE_ID,
        "CROWDSEC_MACHINE_PASSWORD": config.machine_password,
        "CROWDSEC_STREAM_POLL_INTERVAL": "5",
        "DROP_ENABLED": "true",
        "DROP_REFRESH_HOURS": "8760",
    }


def seed_env(environ: Mapping[str, str]) -> dict[str, str]:
    return base_env(environ)


def redacted(env: Mapping[str, str]) -> dict[str, str]:
    return {
        name: "***" if any(word in name for word in ("PASSWORD", "KEY", "SECRET")) else value
        for name, value in env.items()
    }


@dataclass(frozen=True, slots=True)
class Facts:
    in_ci: bool
    mem_available: int
    disk_free: int
    docker_ok: bool
    city_db_exists: bool
    asn_db_exists: bool
    carto_key_set: bool
    site_deps_installed: bool
    vite_dev_running: bool
    ledger_exists: bool
    database_exists: bool
    containers_exist: tuple[str, ...]
    """Containers and networks labelled for a screenshot run."""


def preflight_problems(facts: Facts) -> list[str]:
    problems: list[str] = []
    if facts.in_ci:
        problems.append("CI is set: the screenshot run never runs in CI.")
    if facts.mem_available < MIN_MEMORY:
        problems.append(
            f"Only {facts.mem_available / 2**30:.1f} GiB of memory is available and the run needs 3 GiB; "
            "stop something first."
        )
    if facts.disk_free < MIN_DISK:
        problems.append(
            f"Only {facts.disk_free / 1e9:.1f} GB of disk is free and the run needs 10 GB; free some first."
        )
    if not facts.docker_ok:
        problems.append("docker info failed: start Docker or fix the docker context.")
    if not facts.city_db_exists:
        problems.append("The GeoLite2 City database is missing: pass --city-db.")
    if not facts.asn_db_exists:
        problems.append("The GeoLite2 ASN database is missing: pass --asn-db.")
    if not facts.carto_key_set:
        problems.append(f"No CARTO key: export {CARTO_VAR} or pass --carto-key.")
    if not facts.site_deps_installed:
        problems.append("site/node_modules has no sharp: run bun install in site/.")
    if facts.vite_dev_running:
        problems.append("A Vite dev server is running (public/hot exists): stop the dev server first.")
    if facts.ledger_exists:
        problems.append("The ledger holds resources from an earlier run: run --cleanup first.")
    if facts.database_exists:
        problems.append(
            "The database geometrikks_screenshots already exists: run --cleanup to drop it, or pass --own-db."
        )
    if facts.containers_exist:
        problems.append(
            f"Labelled screenshot resources still exist ({', '.join(facts.containers_exist)}): run --cleanup first."
        )
    return problems
