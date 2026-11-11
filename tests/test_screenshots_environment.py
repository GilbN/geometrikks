"""The screenshot run's environment: the scrub, the child environments and the preflight problems."""

import ast
import dataclasses
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tests.screenshots.environment import (
    SCRUB_NAMES,
    SCRUB_PREFIXES,
    Facts,
    RunConfig,
    ShotInputs,
    app_env,
    base_env,
    database_url,
    preflight_problems,
    redacted,
    scrub_process_env,
    seed_env,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
GIB = 2**30
GB = 10**9
TARGETS = [("edge", "geometrikks-json", Path("/x/edge.log")), ("homelab", "nginx", Path("/x/homelab.log"))]

config = RunConfig(
    run_id="20261111-120000-1",
    pg_admin_url="postgresql://geouser:geopass@localhost:5432/postgres",
    own_db=False,
    app_port=18123,
    bouncer_key="bouncer-secret",
    machine_password="machine-secret",
    city_db=Path("/geo/GeoLite2-City.mmdb"),
    asn_db=Path("/geo/GeoLite2-ASN.mmdb"),
    carto_key="carto-secret",
    live_dir=Path("/x"),
)

GOOD_FACTS = Facts(
    in_ci=False,
    mem_available=8 * GIB,
    disk_free=40 * GB,
    docker_ok=True,
    city_db_exists=True,
    asn_db_exists=True,
    carto_key_set=True,
    site_deps_installed=True,
    vite_dev_running=False,
    ledger_exists=False,
    database_exists=False,
    containers_exist=(),
    database_reachable=True,
)

PROXY_NAMES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")


def test_app_env_never_inherits_geometrikks_settings() -> None:
    environ = {
        "PATH": "/bin",
        "HOME": "/h",
        "CROWDSEC_LAPI_URL": "http://192.168.1.34:8081",
        "CROWDSEC_MACHINE_ID": "real",
        "DB_DATABASE": "geometrikks",
        "LOKI_URL": "http://loki",
        "OIDC_ISSUER": "https://auth",
        "GEOMETRIKKS_ENV_FILE": ".env",
    }
    env = app_env(environ, config, lapi_url="http://172.30.0.2:8080", log_targets=TARGETS)
    assert env["GEOMETRIKKS_ENV_FILE"] == ""
    assert env["CROWDSEC_LAPI_URL"] == "http://172.30.0.2:8080" and env["CROWDSEC_MACHINE_ID"] == "geometrikks-shots"
    assert env["DB_DATABASE"] == "geometrikks_screenshots" and "DB_NAME" not in env
    assert "LOKI_URL" not in env and "OIDC_ISSUER" not in env
    assert env["APP_ADMIN_USER"] == env["APP_ADMIN_PASSWORD"] == "admin"
    assert env["APP_UPDATE_CHECK"] == "false" and env["MAP_AUTO_DETECT_SERVER_LOCATION"] == "false"
    assert json.loads(env["LOGPARSER_SERVER_NAME"]) == ["edge", "homelab"]
    assert json.loads(env["LOGPARSER_LOG_FORMATS"]) == ["geometrikks-json", "nginx"]


def test_app_env_points_every_setting_at_the_run() -> None:
    env = app_env({"PATH": "/bin"}, config, lapi_url="http://172.30.0.2:8080", log_targets=TARGETS)
    assert json.loads(env["LOGPARSER_LOG_PATHS"]) == ["/x/edge.log", "/x/homelab.log"]
    assert (env["DB_HOST"], env["DB_PORT"], env["DB_USER"], env["DB_PASSWORD"]) == (
        "localhost",
        "5432",
        "geouser",
        "geopass",
    )
    assert env["DROP_ENABLED"] == "true" and env["DROP_REFRESH_HOURS"] == "8760"
    assert env["CROWDSEC_BOUNCER_API_KEY"] == "bouncer-secret"
    assert env["CROWDSEC_MACHINE_PASSWORD"] == "machine-secret"
    assert env["MAP_CARTO_API_KEY"] == "carto-secret"
    assert env["GEOIP_DB_PATH"] == "/geo/GeoLite2-City.mmdb" and env["GEOIP_ASN_DB_PATH"] == "/geo/GeoLite2-ASN.mmdb"
    assert env["APP_AUTH_DISABLED"] == "false" and env["VITE_DEV_MODE"] == "false"


def test_base_env_passes_only_the_listed_names() -> None:
    environ = {"PATH": "/bin", "HOME": "/h", "DOCKER_CONTEXT": "remote", "HTTPS_PROXY": "http://p", "CI": "1"}
    assert base_env(environ) == {"PATH": "/bin", "HOME": "/h", "GEOMETRIKKS_ENV_FILE": ""}


def test_database_url_swaps_driver_and_database() -> None:
    assert (
        database_url(config) == "postgresql+asyncpg://geouser:geopass@localhost:5432/geometrikks_screenshots"
    )
    assert database_url(config, driver="postgresql").startswith("postgresql://geouser:")


def test_seed_env_is_bare() -> None:
    assert set(seed_env({"PATH": "/bin", "DB_HOST": "x"})) == {"PATH", "GEOMETRIKKS_ENV_FILE"}


def test_redacted_hides_secrets() -> None:
    assert redacted({"CROWDSEC_BOUNCER_API_KEY": "k", "DB_PASSWORD": "p", "DB_HOST": "h"}) == {
        "CROWDSEC_BOUNCER_API_KEY": "***",
        "DB_PASSWORD": "***",
        "DB_HOST": "h",
    }


def test_scrub_keeps_inputs_and_removes_settings() -> None:
    environ = {
        "PATH": "/bin",
        "MAP_CARTO_API_KEY": "c",
        "SHOTS_PG_ADMIN_URL": "postgresql://a",
        "DB_HOST": "x",
        "LOGPARSER_ENABLED": "true",
        "MAXMINDDB_LICENSE_KEY": "m",
        "GEOMETRIKKS_ENV_FILE": ".env",
        "CI": "",
    }
    assert scrub_process_env(environ) == ShotInputs(carto_key="c", pg_admin_url="postgresql://a")
    assert environ == {"PATH": "/bin", "SHOTS_PG_ADMIN_URL": "postgresql://a", "GEOMETRIKKS_ENV_FILE": "", "CI": ""}


def test_scrub_removes_proxies_and_lowercase_settings() -> None:
    environ = {"PATH": "/bin", "crowdsec_lapi_url": "http://192.168.1.34:8081", "Db_Host": "x"}
    environ |= {name: "http://proxy" for name in PROXY_NAMES} | {name.lower(): "http://proxy" for name in PROXY_NAMES}
    assert scrub_process_env(environ) == ShotInputs(carto_key=None, pg_admin_url=None)
    assert environ == {"PATH": "/bin", "GEOMETRIKKS_ENV_FILE": ""}


def test_scrub_covers_every_settings_prefix() -> None:
    tree = ast.parse((REPO_ROOT / "geometrikks/config/settings.py").read_text())
    names = {
        kw.value.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        for kw in node.keywords
        if kw.arg in ("env_prefix", "validation_alias")
        and isinstance(kw.value, ast.Constant)
        and isinstance(kw.value.value, str)
    }
    assert names and all(name.startswith(SCRUB_PREFIXES) or name in SCRUB_NAMES for name in names)


def test_scrub_covers_direct_environment_reads_and_proxies() -> None:
    reads = set()
    for path in (REPO_ROOT / "geometrikks").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("getenv", "get")
                and isinstance(node.func.value, (ast.Name, ast.Attribute))
                and ast.unparse(node.func.value) in ("os", "os.environ")
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
            ):
                reads.add(node.args[0].value)
    reads.discard("GEOMETRIKKS_ENV_FILE")
    assert {"DISABLE_ROTATION_CHECK", "DISABLE_WAIT"} <= reads
    covered = {*reads, *PROXY_NAMES, *(name.lower() for name in PROXY_NAMES)}
    assert all(name.upper().startswith(SCRUB_PREFIXES) or name.upper() in SCRUB_NAMES for name in covered)


def test_entry_point_scrubs_hostile_settings(tmp_path: Path) -> None:
    hostile_file = tmp_path / "hostile.env"
    hostile_file.write_text("CROWDSEC_LAPI_URL=http://192.168.1.34:8081\nDB_DATABASE=hostile_db\n")
    environ = {
        "PATH": os.environ["PATH"],
        "HOME": str(tmp_path),
        "GEOMETRIKKS_ENV_FILE": str(hostile_file),
        "DB_DATABASE": "hostile_db",
        "CROWDSEC_LAPI_URL": "http://192.168.1.34:8081",
        "CROWDSEC_MACHINE_PASSWORD": "real",
        "MAP_CARTO_API_KEY": "carto-from-env",
    }
    probe = (
        "import os, json, tests.screenshots.__main__ as entry; "
        "from geometrikks.config.settings import CrowdSecSettings, DatabaseSettings; "
        "print(json.dumps([entry.INPUTS.carto_key, DatabaseSettings().database, CrowdSecSettings().lapi_url, "
        "sorted(k for k in os.environ if k.startswith(('DB_', 'CROWDSEC_', 'MAP_')))]))"
    )
    out = subprocess.run(
        [sys.executable, "-c", probe], env=environ, cwd=REPO_ROOT, capture_output=True, text=True, check=True
    )
    assert json.loads(out.stdout) == ["carto-from-env", "geometrikks", None, []]


@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        ({"in_ci": True}, "CI"),
        ({"mem_available": 2 * GIB}, "2.0 GiB"),
        ({"disk_free": 9 * GB}, "9.0 GB"),
        ({"docker_ok": False}, "docker info"),
        ({"ledger_exists": True}, "--cleanup"),
        ({"database_exists": True}, "geometrikks_screenshots"),
        ({"database_reachable": False}, "does not answer"),
        ({"carto_key_set": False}, "MAP_CARTO_API_KEY"),
        ({"vite_dev_running": True}, "public/hot"),
        ({"city_db_exists": False}, "--city-db"),
        ({"asn_db_exists": False}, "--asn-db"),
        ({"site_deps_installed": False}, "bun install"),
        ({"containers_exist": ("geometrikks-shots-net",)}, "geometrikks-shots-net"),
    ],
)
def test_preflight_names_each_problem(change: dict[str, object], fragment: str) -> None:
    problems = preflight_problems(dataclasses.replace(GOOD_FACTS, **change))
    assert len(problems) == 1 and fragment in problems[0]
    assert preflight_problems(GOOD_FACTS) == []


def test_preflight_names_both_resource_numbers() -> None:
    problems = preflight_problems(dataclasses.replace(GOOD_FACTS, mem_available=int(2.5 * GIB), disk_free=9 * GB))
    assert len(problems) == 2
    assert "2.5 GiB" in problems[0] and "3 GiB" in problems[0]
    assert "9.0 GB" in problems[1] and "10 GB" in problems[1]
