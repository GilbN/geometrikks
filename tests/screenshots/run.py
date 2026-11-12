"""The screenshot run: preflight, a throwaway seeded instance, capture, encode, publish, teardown.

``__main__`` scrubs the process environment before it imports this module.
"""

from __future__ import annotations

import argparse
import asyncio
import errno
import json
import os
import random
import secrets
import shutil
import signal
import socket
import sys
import time
import traceback
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Final

import asyncpg
import httpx2
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from geometrikks.config.settings import AnalyticsSettings
from geometrikks.server.migrations import upgrade_to_head
from geometrikks.server.timescale import setup_timescaledb
from geometrikks.services.crowdsec.service import CrowdSecService
from tests.screenshots.doc_traffic import (
    DOC_INSPECT_IP,
    DOC_VISITORS,
    DOCUMENTATION_NETWORKS,
    HOME_VISITORS,
    write_doc_traffic,
)
from tests.screenshots.drop import (
    documentation_only_drop_lists,
    drop_marker_intact,
    feed_bodies,
    import_fixture_lists,
)
from tests.screenshots.environment import (
    Facts,
    RunConfig,
    ShotInputs,
    app_env,
    base_env,
    database_url,
    preflight_problems,
    redacted,
    seed_env,
)
from tests.screenshots.fixture_ips import (
    FixtureIps,
    IpStats,
    load_ip_stats,
    pick_fixture_ips,
)
from tests.screenshots.lapi import (
    CONTAINER,
    MACHINE_ID,
    NETWORK,
    EventRow,
    LapiClient,
    apply_manual_decisions,
    container_args,
    crowdsec_settings,
    fixture_alerts,
    foreign_decisions,
    lapi_url,
    load_events,
    network_args,
)
from tests.screenshots.plan import (
    MissingParamError,
    Shot,
    UnknownSceneError,
    build_shots,
    capture_plan,
    shot_filename,
)
from tests.screenshots.publish import (
    BACKUP_NAME,
    STAGING_NAME,
    build_manifest,
    plan_swap,
    publish_staged,
    recover_publish,
    stage_publish,
)
from tests.screenshots.teardown import (
    LEDGER_PATH,
    REPO_ROOT,
    RESERVED_DATABASE,
    RUN_LABEL,
    RUN_ROOT,
    Interrupted,
    Ledger,
    Resource,
    RunLocked,
    SystemActions,
    _child_exited,
    acquire_run_lock,
    ensure_run_root,
    execute_teardown,
    interrupts_ignored,
    interrupts_raise,
    plan_teardown,
    run_child,
    start_child,
    stop_child,
)
from tests.seed.config import SeedConfig
from tests.seed.live import live_log_targets
from tests.seed.seeder import asyncpg_dsn

DATA_SCREENSHOTS: Final = REPO_ROOT / "data" / "screenshots"
BUNDLE_MANIFEST: Final = REPO_ROOT / "public" / "manifest.json"
VITE_HOT: Final = REPO_ROOT / "public" / "hot"
SITE_SHARP: Final = REPO_ROOT / "site" / "node_modules" / "sharp"
ENCODER: Final = REPO_ROOT / "site" / "scripts" / "encode-screenshots.ts"
SCREENSHOT_VITE_CONFIG: Final = REPO_ROOT / "tests" / "screenshots" / "vite.config.ts"
VITE_ENV_DIR_VAR: Final = "SHOTS_VITE_ENV_DIR"
PLAYWRIGHT_CONFIG: Final = "playwright.screenshots.config.ts"
DEFAULT_PG_ADMIN_URL: Final = "postgresql://geouser:geopass@localhost:5432/postgres"
GEOIP_DIR: Final = Path.home() / "dev" / "geometrikks" / "data" / "geoip"

OWN_DB_CONTAINER: Final = "geometrikks-shots-db"
OWN_DB_IMAGE: Final = "timescale/timescaledb-ha:pg18-ts2.30"
SEED: Final = 42
ROWS: Final = 150_000
DAYS: Final = 30
LIVE_RATE: Final = 4
LIVE_WARMUP_SECONDS: Final = 60
APP_READY_SECONDS: Final = 90
DB_READY_SECONDS: Final = 180
DOCKER_SECONDS: Final = 60
DOCKER_RUN_SECONDS: Final = 600
LOG_TAIL_LINES: Final = 30

EXIT_DONE, EXIT_FAILED, EXIT_REFUSED, EXIT_INTERRUPTED = 0, 1, 2, 130


class RunFailed(Exception):
    def __init__(self, message: str, *, log: Path | None = None) -> None:
        super().__init__(message)
        self.log = log


class Refused(Exception):
    """Preflight found problems; the run starts nothing."""


def say(*parts: object) -> None:
    print(*parts, flush=True)


def parse_args(argv: Sequence[str], inputs: ShotInputs) -> argparse.Namespace:
    def scene_list(value: str) -> list[str]:
        scenes = [part.strip() for part in value.split(",") if part.strip()]
        try:
            build_shots(only=scenes)
        except UnknownSceneError as error:
            raise argparse.ArgumentTypeError(str(error)) from None
        return scenes

    def path(value: str) -> Path:
        return Path(value).expanduser().resolve()

    parser = argparse.ArgumentParser(
        prog="uv run python -m tests.screenshots",
        description="Screenshot a throwaway seeded GeoMetrikks instance and publish the shots to data/screenshots/.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="check and print what a run would do; start nothing")
    mode.add_argument("--cleanup", action="store_true", help="remove everything a crashed or killed run left")
    parser.add_argument("--only", type=scene_list, help="retake these scenes only, comma-separated")
    parser.add_argument("--hold", action="store_true", help="keep the instance up after capture until Enter")
    parser.add_argument("--own-db", action="store_true", help=f"run a private {OWN_DB_IMAGE} container")
    parser.add_argument("--no-build", action="store_true", help="use the frontend bundle already in public/")
    parser.add_argument(
        "--pg-admin-url",
        default=inputs.pg_admin_url or DEFAULT_PG_ADMIN_URL,
        help="admin URL of the TimescaleDB server (default: SHOTS_PG_ADMIN_URL or %(default)s)",
    )
    parser.add_argument("--city-db", type=path, default=GEOIP_DIR / "GeoLite2-City.mmdb", help="GeoLite2-City.mmdb")
    parser.add_argument("--asn-db", type=path, default=GEOIP_DIR / "GeoLite2-ASN.mmdb", help="GeoLite2-ASN.mmdb")
    parser.add_argument(
        "--carto-key", default=inputs.carto_key, help="CARTO basemap key (default: MAP_CARTO_API_KEY)"
    )
    return parser.parse_args(list(argv))


def main(args: argparse.Namespace, inputs: ShotInputs) -> int:
    say(f"orchestrator pid {os.getpid()}")
    ensure_run_root()
    try:
        acquire_run_lock()
    except RunLocked as error:
        say(f"{error}; exiting")
        return EXIT_REFUSED
    os.chdir(REPO_ROOT)
    if args.cleanup:
        return cleanup(args)
    if args.dry_run:
        return dry_run(args)
    return full_run(args)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("0.0.0.0", 0))
        return probe.getsockname()[1]


def _tail(path: Path, lines: int = LOG_TAIL_LINES) -> str:
    try:
        return "\n".join(path.read_text(errors="replace").splitlines()[-lines:])
    except OSError:
        return ""


def _plain_url(url: str) -> str:
    return make_url(url).set(drivername="postgresql").render_as_string(hide_password=False)


def bun_argv(bun: str, *args: str) -> list[str]:
    """Bun loads ``.env`` from its working directory by default, and the repo root holds the owner's."""
    return [bun, "--no-env-file", *args]


def sweep_marked(marker: Callable[[bytes], bool], *, proc_root: Path = Path("/proc")) -> tuple[list[str], bool]:
    """Kill our own processes whose environment matches ``marker``; return the report and whether a kill failed.

    Playwright starts browsers in process groups of their own, so stopping its group can miss them.
    """
    report: list[str] = []
    failed = False
    for entry in proc_root.iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            if entry.stat().st_uid != os.getuid():
                continue
            pidfd = os.pidfd_open(int(entry.name))
        except OSError:
            continue
        try:
            # Opened before the read and killed through, the pidfd can only reach the process it was opened
            # for: if that one exits and its pid is reused, the kill fails instead of hitting the new owner.
            try:
                environ = (entry / "environ").read_bytes()
            except OSError:
                continue
            if not any(marker(pair) for pair in environ.split(b"\0")):
                continue
            try:
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            except OSError as error:
                if error.errno != errno.ESRCH:
                    report.append(f"could not stop stray process {entry.name} from a capture: {error}")
                    failed = True
                continue
        finally:
            os.close(pidfd)
        report.append(f"stopped stray process {entry.name} from a capture")
    return report, failed


class Runner:
    """Runs every child through the ledger, from the repo root, with logs in one folder."""

    def __init__(self, *, ledger: Ledger, env: dict[str, str], log_dir: Path) -> None:
        self.ledger = ledger
        self.env = env
        self.log_dir = log_dir
        self.path = env.get("PATH", "")

    def which(self, name: str) -> str:
        found = shutil.which(name, path=self.path)
        if found is None:
            raise RunFailed(f"{name} is not on the run's PATH ({self.path})")
        return found

    def run(
        self,
        argv: Sequence[str],
        *,
        label: str,
        log: str,
        env: dict[str, str] | None = None,
        stdout: str | None = None,
        timeout: float | None = None,
    ) -> int:
        return run_child(
            argv,
            env=self.env if env is None else env,
            log_path=self.log_dir / log,
            label=label,
            ledger=self.ledger,
            stdout_path=self.log_dir / stdout if stdout else None,
            timeout=timeout,
        )

    def capture(self, argv: Sequence[str], *, label: str, timeout: float = DOCKER_SECONDS) -> tuple[int, str]:
        out_name = f"{label.replace(' ', '-')}.out"
        code = self.run(argv, label=label, log="commands.log", stdout=out_name, timeout=timeout)
        return code, (self.log_dir / out_name).read_text(errors="replace")

    def docker(self, *args: str, label: str, timeout: float = DOCKER_SECONDS) -> tuple[int, str]:
        return self.capture([self.which("docker"), *args], label=label, timeout=timeout)

    def docker_or_fail(self, *args: str, label: str, timeout: float = DOCKER_SECONDS) -> str:
        code, out = self.docker(*args, label=label, timeout=timeout)
        if code != 0:
            raise RunFailed(f"{label} exited {code}", log=self.log_dir / "commands.log")
        return out


def _labelled(runner: Runner) -> list[tuple[str, str, str]]:
    """``(kind, name, run id)`` for every container and network carrying the run label."""
    template = f'{{{{.Names}}}}\t{{{{.Label "{RUN_LABEL}"}}}}'
    found = []
    for kind, args, name_field in (
        ("container", ("ps", "-a", "--filter", f"label={RUN_LABEL}", "--format"), "{{.Names}}"),
        ("network", ("network", "ls", "--filter", f"label={RUN_LABEL}", "--format"), "{{.Name}}"),
    ):
        out = runner.docker_or_fail(*args, template.replace("{{.Names}}", name_field), label=f"docker list {kind}s")
        for line in out.splitlines():
            if line.strip():
                name, _, run_id = line.partition("\t")
                found.append((kind, name.strip(), run_id.strip()))
    return found


async def _database_exists(admin_url: str) -> bool:
    conn = await asyncpg.connect(_plain_url(admin_url), timeout=10)
    try:
        return await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", RESERVED_DATABASE) is not None
    finally:
        await conn.close()


def _mem_available() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    return 0


def gather_facts(args: argparse.Namespace, runner: Runner, *, ledger_exists: bool) -> Facts:
    docker_ok = shutil.which("docker", path=runner.path) is not None and (
        runner.run([runner.which("docker"), "info"], label="docker info", log="commands.log", timeout=30) == 0
    )
    labelled = [f"{kind} {name}" for kind, name, _ in _labelled(runner)] if docker_ok else []
    database_exists, database_reachable = False, True
    if not args.own_db:
        try:
            database_exists = asyncio.run(_database_exists(args.pg_admin_url))
        except (OSError, asyncpg.PostgresError, TimeoutError) as error:
            say(f"could not check for {RESERVED_DATABASE} on {make_url(args.pg_admin_url)!s}: {error}")
            database_reachable = False
    return Facts(
        in_ci=bool(os.environ.get("CI")),
        mem_available=_mem_available(),
        disk_free=shutil.disk_usage("/").free,
        docker_ok=docker_ok,
        city_db_exists=args.city_db.is_file(),
        asn_db_exists=args.asn_db.is_file(),
        carto_key_set=bool(args.carto_key),
        site_deps_installed=SITE_SHARP.is_dir(),
        vite_dev_running=VITE_HOT.exists(),
        ledger_exists=ledger_exists,
        database_exists=database_exists,
        containers_exist=tuple(labelled),
        database_reachable=database_reachable,
    )


def _report_problems(problems: Sequence[str]) -> None:
    if not problems:
        say("preflight: no problems")
    for problem in problems:
        say(f"preflight: {problem}")


def _shared_ledger_foreign(owned: Sequence[Resource]) -> bool:
    try:
        entries = Ledger(LEDGER_PATH).load()
    except (ValueError, TypeError) as error:
        say(f"the ledger at {LEDGER_PATH} is unreadable: {error}")
        return True
    return any(entry not in owned for entry in entries)


def _shot_list(only: Sequence[str] | None) -> list[Shot]:
    return build_shots(only=set(only) if only else None)


def _playwright_env(env: dict[str, str], *, plan: Path, output: Path) -> dict[str, str]:
    return {
        **env,
        "SHOTS_PLAN": str(plan),
        "SHOTS_ADMIN_USER": "admin",
        "SHOTS_ADMIN_PASSWORD": "admin",
        "SHOTS_OUTPUT": str(output),
    }


def _teardown(resources: Sequence[Resource], ledger: Ledger, env: dict[str, str], log_dir: Path) -> list[str]:
    if not resources:
        # Every docker call adds and then discards a child entry, which leaves an empty ledger file behind.
        if ledger.exists() and not _ledger_holds(ledger):
            ledger.clear()
        return []
    try:
        actions = SystemActions(ledger=ledger, env=env, log_dir=log_dir)
    except RuntimeError as error:
        return [f"teardown could not start: {error}"]
    return execute_teardown(resources, run_root=RUN_ROOT, ledger=ledger, actions=actions)


def _ledger_holds(ledger: Ledger) -> bool:
    try:
        return bool(ledger.load())
    except (ValueError, TypeError):
        return True


def _ledger_left() -> bool:
    return _ledger_holds(Ledger(LEDGER_PATH))


def _retake_problem(only: Sequence[str] | None) -> str | None:
    """A retake merges into the published manifest, so it needs one it can read."""
    if not only:
        return None
    path = DATA_SCREENSHOTS / "manifest.json"
    try:
        manifest = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        return f"--only needs a readable {path} ({error}): run a full run first."
    if not isinstance(manifest, dict) or not isinstance(manifest.get("scenes"), dict):
        return f"--only needs a manifest with scenes, and {path} has none: run a full run first."
    return None


def _recover(prefix: str) -> bool:
    """Run the publish recovery; report and return False when it fails, so the caller still tears down."""
    try:
        for line in recover_publish(DATA_SCREENSHOTS):
            say(f"{prefix}: {line}")
    except Exception as error:  # noqa: BLE001
        say(
            f"{prefix}: publish recovery failed: {error}; "
            f"check {DATA_SCREENSHOTS}, {STAGING_NAME} and {BACKUP_NAME} next to it by hand"
        )
        return False
    return True


def _print_teardown(report: Sequence[str]) -> None:
    for line in report:
        say(f"teardown: {line}")
    if _ledger_left():
        say("teardown: the ledger still lists resources; run `uv run python -m tests.screenshots --cleanup`")
    else:
        say("teardown: done")


# --- dry run ---------------------------------------------------------------------------------------------


def dry_run(args: argparse.Namespace) -> int:
    scratch = RUN_ROOT / f"dry-{os.getpid()}"
    private = Ledger(scratch / "ledger.json")
    env = base_env(os.environ)
    logs = scratch / "logs"
    code = EXIT_DONE
    # Ignored outside the raise block too, so leaving it never restores the default handlers before teardown.
    with interrupts_ignored():
        try:
            with interrupts_raise():
                try:
                    scratch.mkdir(mode=0o700)
                    logs.mkdir()
                    runner = Runner(ledger=private, env=env, log_dir=logs)
                    facts = gather_facts(args, runner, ledger_exists=_shared_ledger_foreign(()))
                    problems = preflight_problems(facts)
                    retake = _retake_problem(args.only)
                    if retake is not None:
                        problems.append(retake)
                    _report_problems(problems)
                    _print_dry_env(args, env)
                    shots = _shot_list(args.only)
                    for shot in shots:
                        say(f"shot: {shot.name}{' (live)' if shot.scene.live else ''}")
                    say(f"{len(shots)} shots")
                    _print_dry_teardown(args)
                    plan_path = scratch / "plan.json"
                    params = {"inspect_ip": DOC_INSPECT_IP, "focus_location": "1"}
                    plan = capture_plan(shots, params, base_url="http://127.0.0.1:8000", png_dir=scratch / "png")
                    plan_path.write_text(json.dumps(plan, indent=2))
                    listed = runner.run(
                        [runner.which("npx"), "playwright", "test", f"--config={PLAYWRIGHT_CONFIG}", "--list"],
                        label="playwright --list",
                        log="playwright-list.log",
                        env=_playwright_env(env, plan=plan_path, output=scratch / "playwright"),
                    )
                    say(_tail(logs / "playwright-list.log", lines=200))
                    say(f"playwright --list exited {listed}")
                    code = dry_run_exit(has_problems=bool(problems), listed=listed)
                except (RunFailed, MissingParamError) as error:
                    say(f"dry run failed: {error.args[0]}")
                    code = EXIT_FAILED
        except Interrupted:
            code = EXIT_INTERRUPTED
        finally:
            with interrupts_ignored():
                for line in _teardown(private.owned(), private, env, logs if logs.is_dir() else scratch):
                    say(f"teardown: {line}")
                if _ledger_holds(private):
                    say(f"teardown: kept {scratch}, its ledger still lists resources; run --cleanup")
                    code = code or EXIT_FAILED
                else:
                    shutil.rmtree(scratch, ignore_errors=True)
    return code


def dry_run_exit(*, has_problems: bool, listed: int) -> int:
    """Preflight problems outrank a failed ``--list``, which still fails the dry run."""
    if has_problems:
        return EXIT_REFUSED
    return EXIT_FAILED if listed != 0 else EXIT_DONE


def _print_dry_env(args: argparse.Namespace, env: dict[str, str]) -> None:
    admin_url = "postgresql://geouser:geopass@127.0.0.1:5432/postgres" if args.own_db else args.pg_admin_url
    config = RunConfig(
        run_id="dry-run",
        pg_admin_url=admin_url,
        own_db=args.own_db,
        app_port=0,
        bouncer_key="placeholder",
        machine_password="placeholder",
        city_db=args.city_db,
        asn_db=args.asn_db,
        carto_key=args.carto_key or "",
        live_dir=RUN_ROOT / "run-<id>" / "live",
    )
    targets = live_log_targets(config.servers, config.live_dir)
    listing = redacted(app_env(env, config, lapi_url=lapi_url("<lapi ip>"), log_targets=targets))
    if args.own_db:
        listing["DB_HOST"], listing["DB_PORT"] = "127.0.0.1", "<db port>"
    say("app environment (the app listens on 0.0.0.0:<app port>):")
    for name in sorted(listing):
        say(f"  {name}={listing[name]}")


def _print_dry_teardown(args: argparse.Namespace) -> None:
    run_id = (("run_id", "dry-run"),)
    admin_url = (("admin_url", args.pg_admin_url),)
    run_dir = RUN_ROOT / "run-<id>"
    resources = [Resource("directory", str(run_dir))]
    if args.own_db:
        resources += [
            Resource("container", OWN_DB_CONTAINER, run_id),
            Resource("database", RESERVED_DATABASE, (*admin_url, ("container", OWN_DB_CONTAINER))),
        ]
    else:
        resources.append(Resource("database", RESERVED_DATABASE, admin_url))
    resources += [
        Resource("network", NETWORK, run_id),
        Resource("container", CONTAINER, run_id),
        Resource("process", "999998", (("label", "app"),)),
        Resource("process", "999997", (("label", "feeder"),)),
    ]
    say("teardown plan for a full run, in order:")
    for resource in plan_teardown(resources, run_root=RUN_ROOT):
        if resource.kind == "process":
            say(f"  stop the {resource.meta_value('label')} process group")
        else:
            say(f"  remove {resource.kind} {resource.ident}")
    if args.own_db:
        say(f"  ({RESERVED_DATABASE} goes with {OWN_DB_CONTAINER})")


# --- cleanup ---------------------------------------------------------------------------------------------


def cleanup(args: argparse.Namespace) -> int:
    env = base_env(os.environ)
    scratch = RUN_ROOT / f"cleanup-{os.getpid()}"
    with interrupts_ignored():
        try:
            return _cleanup(args, env, scratch)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)


def _cleanup(args: argparse.Namespace, env: dict[str, str], scratch: Path) -> int:
    clean = _recover("cleanup")
    scratch.mkdir(mode=0o700)
    shared = Ledger(LEDGER_PATH)
    ledger = shared
    try:
        entries = shared.load()
    except (ValueError, TypeError) as error:
        say(f"cleanup: the ledger at {LEDGER_PATH} is unreadable ({error}); it stays for you to read and delete")
        say("cleanup: removing the labelled containers and networks and the reserved database only")
        entries = []
        ledger = Ledger(scratch / "ledger.json")
        clean = False

    runner = Runner(ledger=ledger, env=env, log_dir=scratch)
    discovered: list[Resource] = []
    known = {(entry.kind, entry.ident) for entry in entries if entry.kind in ("container", "network")}
    try:
        for kind, name, run_id in _labelled(runner):
            if (kind, name) not in known:
                discovered.append(
                    Resource("container" if kind == "container" else "network", name, (("run_id", run_id),))
                )
    except RunFailed as error:
        say(f"cleanup: could not list labelled resources: {error}")
        clean = False
    # An --own-db run's database lives in its labelled container, so the shared server holds nothing of it.
    if not args.own_db:
        try:
            if asyncio.run(_database_exists(args.pg_admin_url)):
                admin = (("admin_url", args.pg_admin_url),)
                if not any(entry.kind == "database" and entry.meta == admin for entry in entries):
                    discovered.append(Resource("database", RESERVED_DATABASE, admin))
        except (OSError, asyncpg.PostgresError, TimeoutError) as error:
            say(f"cleanup: could not check for {RESERVED_DATABASE} on {make_url(args.pg_admin_url)!s}: {error}")
            clean = False
    # In the ledger first, so whatever teardown cannot remove stays listed and fails the exit status.
    for resource in discovered:
        ledger.add(resource)
    entries += discovered

    for entry in entries:
        say(f"cleanup: found {entry.kind} {entry.ident}")
    report = _teardown(entries, ledger, env, scratch)
    run_root_marker = f"SHOTS_PLAN={RUN_ROOT}/".encode()
    swept, sweep_failed = sweep_marked(lambda pair: pair.startswith(run_root_marker))
    report += swept
    if sweep_failed:
        clean = False
    for folder in sorted(RUN_ROOT.glob("dry-*")):
        private = Ledger(folder / "ledger.json")
        try:
            private_entries = private.load()
        except (ValueError, TypeError) as error:
            report.append(f"kept {folder}: its ledger is unreadable ({error}); read it, stop what it lists, delete it")
            clean = False
            continue
        for entry in private_entries:
            say(f"cleanup: found {entry.kind} {entry.ident} in {folder.name}")
        report += _teardown(private_entries, private, env, scratch)
        if _ledger_holds(private):
            report.append(f"kept {folder}: its ledger still lists resources")
            clean = False
        else:
            shutil.rmtree(folder, ignore_errors=True)
            report.append(f"removed the dry-run folder {folder}")
    for line in report:
        say(f"cleanup: {line}")
    if ledger is not shared:
        say(f"cleanup: read {LEDGER_PATH}, stop anything it lists by hand, then delete it")
    elif _ledger_left():
        say(f"cleanup: {LEDGER_PATH} still lists resources; see the lines above")
        clean = False
    if not clean:
        say("cleanup: something is left; see the lines above")
        return EXIT_FAILED
    say("cleanup: nothing left")
    return EXIT_DONE


# --- full run --------------------------------------------------------------------------------------------


def full_run(args: argparse.Namespace) -> int:
    run_id = f"{datetime.now(UTC):%Y%m%dT%H%M%SZ}-{os.getpid()}"
    run_dir = RUN_ROOT / f"run-{run_id}"
    logs = run_dir / "logs"
    ledger = Ledger(LEDGER_PATH)
    env = base_env(os.environ)
    plan_marker = f"SHOTS_PLAN={run_dir / 'plan.json'}".encode()
    code = EXIT_FAILED
    # Ignored outside the raise block too, so leaving it never restores the default handlers before teardown.
    with interrupts_ignored():
        try:
            with interrupts_raise():
                try:
                    if not _recover("publish recovery"):
                        raise RunFailed("the publish recovery failed")
                    retake = _retake_problem(args.only)
                    if retake is not None:
                        say(retake)
                        raise Refused
                    try:
                        ledger.load()
                    except (ValueError, TypeError) as error:
                        say(f"the ledger is unreadable ({error}): run --cleanup first")
                        raise Refused from None
                    directory = Resource("directory", str(run_dir), state="intended")
                    ledger.add(directory)
                    run_dir.mkdir(mode=0o700)
                    logs.mkdir()
                    ledger.mark_acquired(directory)
                    say(f"run {run_id}: logs in {logs}")
                    FullRun(args, run_id=run_id, run_dir=run_dir, ledger=ledger, env=env).execute()
                    code = EXIT_DONE
                except Refused:
                    code = EXIT_REFUSED
                except (RunFailed, TimeoutError, MissingParamError) as error:
                    say(f"run failed: {error.args[0] if error.args else repr(error)}")
                    log = getattr(error, "log", None)
                    if log is not None:
                        say(f"last lines of {log}:\n{_tail(log)}")
                    code = EXIT_FAILED
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
                    code = EXIT_FAILED
        except Interrupted as interrupt:
            say(f"{interrupt}; tearing down")
            code = EXIT_INTERRUPTED
        finally:
            # A signal that lands while interrupts_raise restores its handlers can leave them raising.
            with interrupts_ignored():
                try:
                    if not _recover("publish recovery"):
                        code = code or EXIT_FAILED
                finally:
                    report = _teardown(ledger.owned(), ledger, env, logs if logs.is_dir() else RUN_ROOT)
                    swept, sweep_failed = sweep_marked(lambda pair: pair == plan_marker)
                    _print_teardown(report + swept)
                    if code == EXIT_DONE and (ledger.owned() or sweep_failed):
                        code = EXIT_FAILED
    say(f"exit {code}")
    return code


class FullRun:
    config: RunConfig
    url: str
    now: datetime
    fixture: FixtureIps
    stats: dict[str, IpStats]
    events: dict[str, list[EventRow]]
    lapi: str

    def __init__(
        self, args: argparse.Namespace, *, run_id: str, run_dir: Path, ledger: Ledger, env: dict[str, str]
    ) -> None:
        self.args = args
        self.run_id = run_id
        self.run_dir = run_dir
        self.logs = run_dir / "logs"
        self.ledger = ledger
        self.env = env
        self.runner = Runner(ledger=ledger, env=env, log_dir=self.logs)
        self.shots = _shot_list(args.only)
        self.plan_path = run_dir / "plan.json"
        self.png_dir = run_dir / "png"

    def execute(self) -> None:
        self.preflight()
        app_port = _free_port()
        pg_admin_url = self.args.pg_admin_url
        if not self.args.no_build:
            self.build()
        if not BUNDLE_MANIFEST.is_file():
            raise RunFailed(f"{BUNDLE_MANIFEST.relative_to(REPO_ROOT)} is missing: run without --no-build")
        if self.args.own_db:
            pg_admin_url = self.start_own_database()
        self.config = RunConfig(
            run_id=self.run_id,
            pg_admin_url=pg_admin_url,
            own_db=self.args.own_db,
            app_port=app_port,
            bouncer_key=secrets.token_hex(16),
            machine_password=secrets.token_hex(16),
            city_db=self.args.city_db,
            asn_db=self.args.asn_db,
            carto_key=self.args.carto_key,
            live_dir=self.run_dir / "live",
        )
        self.url = database_url(self.config)
        self.create_database()
        self.seed()
        self.now = datetime.now(UTC)
        self.fixture, self.stats, self.events = asyncio.run(self.fixtures())
        self.lapi = self.start_crowdsec()
        self.start_app()
        self.capture_and_publish()

    # Steps 9 to 14
    def capture_and_publish(self) -> None:
        failure: Exception | None = None
        try:
            self.capture()
        except Exception as error:  # noqa: BLE001
            failure = error
        if self.args.hold:
            self.hold(failure)
        if failure is not None:
            raise failure
        self.publish(self.encode())

    # Step 1
    def preflight(self) -> None:
        facts = gather_facts(self.args, self.runner, ledger_exists=_shared_ledger_foreign(self.ledger.owned()))
        problems = preflight_problems(facts)
        _report_problems(problems)
        if problems:
            raise Refused

    # Step 3
    def build(self) -> None:
        say("building the frontend bundle (logs/build.log)")
        env_dir = self.run_dir / "vite-env"
        env_dir.mkdir()
        argv = bun_argv(self.runner.which("bun"), "run", "vite", "build", f"--config={SCREENSHOT_VITE_CONFIG}")
        code = self.runner.run(
            argv, label="vite build", log="build.log", env={**self.env, VITE_ENV_DIR_VAR: str(env_dir)}
        )
        if code != 0:
            raise RunFailed(f"vite build exited {code}", log=self.logs / "build.log")
        code, out = self.runner.capture(
            [self.runner.which("git"), "status", "--porcelain", "resources/generated"], label="git status"
        )
        if code != 0 or out.strip():
            raise RunFailed(
                "the build rewrote resources/generated; restore it with git checkout before committing anything\n"
                + out.rstrip()
            )
        say("build done, resources/generated clean")

    # Step 4
    def start_own_database(self) -> str:
        db_port = _free_port()
        container = Resource("container", OWN_DB_CONTAINER, (("run_id", self.run_id),), state="intended")
        self.ledger.add(container)
        self.runner.docker_or_fail(
            "run", "-d",
            "--name", OWN_DB_CONTAINER,
            "--label", f"{RUN_LABEL}={self.run_id}",
            "--memory", "1g",
            "--shm-size", "256m",
            "-p", f"127.0.0.1:{db_port}:5432",
            "-e", "POSTGRES_USER=geouser",
            "-e", "POSTGRES_PASSWORD=geopass",
            OWN_DB_IMAGE,
            "-c", "timescaledb.max_background_workers=40",
            "-c", "max_parallel_workers=8",
            "-c", "max_worker_processes=51",
            "-c", "shared_buffers=128MB",
            label="docker run db",
            timeout=DOCKER_RUN_SECONDS,
        )  # fmt: skip
        self.ledger.mark_acquired(container)
        deadline = time.monotonic() + DB_READY_SECONDS
        # The image's first-boot server listens on its socket only, so a TCP answer means the real server is up.
        while self.runner.docker(
            "exec", OWN_DB_CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "geouser", label="pg_isready"
        )[0]:
            if time.monotonic() > deadline:
                raise RunFailed(f"{OWN_DB_CONTAINER} was not ready after {DB_READY_SECONDS} s")
            time.sleep(1)
        say(f"{OWN_DB_CONTAINER} ready on 127.0.0.1:{db_port}")
        return f"postgresql://geouser:geopass@127.0.0.1:{db_port}/postgres"

    def create_database(self) -> None:
        meta: tuple[tuple[str, str], ...] = (("admin_url", self.config.pg_admin_url),)
        if self.config.own_db:
            meta += (("container", OWN_DB_CONTAINER),)
        database = Resource("database", RESERVED_DATABASE, meta, state="intended")
        self.ledger.add(database)
        asyncio.run(self._create_database())
        self.ledger.mark_acquired(database)
        say(f"database {RESERVED_DATABASE} created and migrated")

    async def _create_database(self) -> None:
        conn = await asyncpg.connect(_plain_url(self.config.pg_admin_url), timeout=10)
        try:
            await conn.execute(f"CREATE DATABASE {RESERVED_DATABASE}")
        finally:
            await conn.close()
        await asyncio.to_thread(upgrade_to_head, self.url)
        engine = create_async_engine(self.url)
        try:
            await setup_timescaledb(engine, AnalyticsSettings())
        finally:
            await engine.dispose()

    # Step 5
    def seed(self) -> None:
        say(f"seeding {ROWS:,} requests over {DAYS} days (logs/seed.log)")
        argv = [
            sys.executable, "-m", "tests.seed",
            "--database-url", self.url,
            "--city-db", str(self.config.city_db),
            "--asn-db", str(self.config.asn_db),
            "--seed", str(SEED),
            "--rows", str(ROWS),
            "--days", str(DAYS),
            "--servers", ",".join(self.config.servers),
        ]  # fmt: skip
        code = self.runner.run(argv, label="seed", log="seed.log", env=seed_env(os.environ))
        if code != 0:
            raise RunFailed(f"the seed exited {code}", log=self.logs / "seed.log")
        say(f"seed: {_tail(self.logs / 'seed.log', lines=1)}")

    # Step 6
    async def fixtures(self) -> tuple[FixtureIps, dict[str, IpStats], dict[str, list[EventRow]]]:
        conn = await asyncpg.connect(asyncpg_dsn(self.url))
        engine = create_async_engine(self.url)
        try:
            started = time.monotonic()
            written = await write_doc_traffic(
                conn,
                SeedConfig(rows=ROWS, seed=SEED, servers=self.config.servers),
                now=self.now,
                rng=random.Random(SEED),
            )
            say(
                f"documentation traffic: {written.scanner_requests} requests from {len(DOC_VISITORS)} scanners "
                f"and {written.home_requests} from {len(HOME_VISITORS)} home visitors "
                f"(written and aggregates refreshed in {time.monotonic() - started:.1f} s)"
            )
            say(
                "top networks, last 7 days: "
                + ", ".join(f"AS{network.asn} {network.organization} {network.hits}" for network in written.top_networks)
            )
            stats = await load_ip_stats(conn, since=self.now - timedelta(days=7))
            fixture = pick_fixture_ips(stats)
            events = await load_events(conn, fixture.all_ips())
            say(
                f"fixtures: {len(fixture.active_bans)} active bans, {len(fixture.expired_bans)} expired, "
                f"{len(fixture.detections)} detections, 1 captcha, 1 range, {len(fixture.drop_bans)} DROP bans, "
                f"{len(fixture.drop_networks)} DROP networks"
            )
            outcomes = await import_fixture_lists(
                async_sessionmaker(engine, expire_on_commit=False),
                feed_bodies(fixture.drop_networks, now=self.now),
                now=self.now,
            )
            say("DROP import: " + ", ".join(f"{outcome.feed} {outcome.status}" for outcome in outcomes))
            listed = await documentation_only_drop_lists(conn)
            if listed:
                raise RunFailed(f"DROP lists hold non-documentation entries: {', '.join(listed)}")
        finally:
            await conn.close()
            await engine.dispose()
        return fixture, {entry.ip: entry for entry in stats}, events

    # Step 7
    def start_crowdsec(self) -> str:
        run_id = (("run_id", self.run_id),)
        network = Resource("network", NETWORK, run_id, state="intended")
        self.ledger.add(network)
        self.runner.docker_or_fail(*network_args(run_id=self.run_id)[1:], label="docker network create")
        self.ledger.mark_acquired(network)
        container = Resource("container", CONTAINER, run_id, state="intended")
        self.ledger.add(container)
        self.runner.docker_or_fail(
            *container_args(run_id=self.run_id, bouncer_key=self.config.bouncer_key)[1:],
            label="docker run crowdsec",
            timeout=DOCKER_RUN_SECONDS,
        )
        self.ledger.mark_acquired(container)
        networks = json.loads(
            self.runner.docker_or_fail(
                "inspect", "--format", "{{json .NetworkSettings.Networks}}", CONTAINER, label="docker inspect"
            )
        )
        address = networks.get(NETWORK, {}).get("IPAddress")
        if not address:
            raise RunFailed(f"{CONTAINER} has no address on {NETWORK}: {networks!r}")
        lapi = lapi_url(address)
        asyncio.run(self._wait_lapi(lapi))
        self.runner.docker_or_fail(
            "exec", CONTAINER, "cscli", "machines", "add", MACHINE_ID,
            "--password", self.config.machine_password, "-f", "/dev/null",
            label="cscli machines add",
        )  # fmt: skip
        foreign = asyncio.run(self._load_lapi(lapi, address))
        say(f"LAPI at {lapi} ready, alerts posted, {len(foreign)} foreign decisions")
        if foreign:
            raise RunFailed(f"LAPI holds decisions for non-fixture values: {', '.join(foreign)}")
        return lapi

    async def _wait_lapi(self, lapi: str) -> None:
        client = LapiClient(lapi)
        try:
            await client.wait_ready(self.config.bouncer_key)
        finally:
            await client.aclose()

    async def _load_lapi(self, lapi: str, address: str) -> list[str]:
        client = LapiClient(lapi)
        service = CrowdSecService(
            crowdsec_settings(
                address,
                bouncer_key=self.config.bouncer_key,
                machine_id=MACHINE_ID,
                password=self.config.machine_password,
            )
        )
        try:
            await client.login(MACHINE_ID, self.config.machine_password)
            await client.post_alerts(fixture_alerts(self.fixture, self.stats, self.events, now=datetime.now(UTC)))
            await apply_manual_decisions(service, self.fixture)
            await asyncio.sleep(2)
            return foreign_decisions(await client.decision_values(self.config.bouncer_key), self.fixture)
        finally:
            await service.aclose()
            await client.aclose()

    # Step 8
    def start_app(self) -> None:
        targets = live_log_targets(self.config.servers, self.config.live_dir)
        self.config.live_dir.mkdir()
        for _, _, path in targets:
            path.write_text("")
        env = app_env(os.environ, self.config, lapi_url=self.lapi, log_targets=targets)
        argv = [
            sys.executable, "-m", "uvicorn", "--factory", "geometrikks.server.core:create_app",
            "--host", "0.0.0.0", "--port", str(self.config.app_port),
        ]  # fmt: skip
        say(f"starting the app on port {self.config.app_port} (logs/app.log)")
        app = start_child(argv, env=env, log_path=self.logs / "app.log", label="app", ledger=self.ledger)
        base = f"http://127.0.0.1:{self.config.app_port}"
        deadline = time.monotonic() + APP_READY_SECONDS
        with httpx2.Client(base_url=base, timeout=5, trust_env=False) as client:
            while True:
                if _child_exited(app.pid) is not False:
                    raise RunFailed("the app exited during startup", log=self.logs / "app.log")
                try:
                    if client.get("/health").status_code == 200:
                        break
                except httpx2.HTTPError:
                    pass
                if time.monotonic() > deadline:
                    raise RunFailed(
                        f"/health did not answer 200 within {APP_READY_SECONDS} s", log=self.logs / "app.log"
                    )
                time.sleep(1)
            login = client.post("/api/v1/auth/login", json={"username": "admin", "password": "admin"})
            if not login.is_success:
                raise RunFailed(f"login as admin answered {login.status_code}", log=self.logs / "app.log")
        self.check_drop_lists()
        say("app healthy, login ok, DROP marker intact, DROP lists documentation-only")

    def check_drop_lists(self) -> None:
        problems = asyncio.run(self._drop_problems())
        if problems:
            raise RunFailed("; ".join(problems))

    async def _drop_problems(self) -> list[str]:
        conn = await asyncpg.connect(asyncpg_dsn(self.url))
        try:
            return await _drop_problems(conn)
        finally:
            await conn.close()

    # Steps 9 to 11
    def capture(self) -> None:
        params = {"inspect_ip": self.fixture.inspect_ip, "focus_location": str(self.fixture.focus_location)}
        plan = capture_plan(
            self.shots, params, base_url=f"http://127.0.0.1:{self.config.app_port}", png_dir=self.png_dir
        )
        self.png_dir.mkdir()
        self.plan_path.write_text(json.dumps(plan, indent=2))
        still = [shot for shot in self.shots if not shot.scene.live]
        live = [shot for shot in self.shots if shot.scene.live]
        if still:
            self.playwright_pass("pass 1", "--grep-invert")
        live_since = None
        if live:
            live_since = self.live_pass()
        problems = asyncio.run(self._final_checks(live_since))
        missing = [shot.name for shot in self.shots if not (self.png_dir / f"{shot.name}.png").is_file()]
        if missing:
            problems.append(f"{len(missing)} planned PNGs are missing: {', '.join(missing)}")
        if problems:
            raise RunFailed("; ".join(problems))
        say(f"checks passed again, {len(self.shots)} PNGs in {self.png_dir}")

    def playwright_pass(self, name: str, grep: str) -> None:
        say(f"capture {name} (logs/{name.replace(' ', '')}.log)")
        log = f"{name.replace(' ', '')}.log"
        code = self.runner.run(
            [self.runner.which("npx"), "playwright", "test", f"--config={PLAYWRIGHT_CONFIG}", grep, "@live"],
            label=f"playwright {name}",
            log=log,
            env=_playwright_env(self.env, plan=self.plan_path, output=self.run_dir / "playwright"),
        )
        say(f"capture {name}: {_tail(self.logs / log, lines=1)}")
        if code != 0:
            raise RunFailed(f"Playwright {name} exited {code}", log=self.logs / log)

    def live_pass(self) -> datetime:
        live_since = datetime.now(UTC)
        argv = [
            sys.executable, "-m", "tests.seed.live",
            "--log-dir", str(self.config.live_dir),
            "--city-db", str(self.config.city_db),
            "--asn-db", str(self.config.asn_db),
            "--seed", str(SEED),
            "--rows", str(ROWS),
            "--servers", ",".join(self.config.servers),
            "--rate", str(LIVE_RATE),
        ]  # fmt: skip
        stdout = self.logs / "feeder.out"
        feeder = start_child(
            argv, env=seed_env(os.environ), log_path=self.logs / "feeder.log", label="feeder", ledger=self.ledger,
            stdout_path=stdout,
        )  # fmt: skip
        try:
            deadline = time.monotonic() + 60
            while "Writing about" not in stdout.read_text(errors="replace"):
                if _child_exited(feeder.pid) is not False:
                    raise RunFailed("the live feeder exited before it started writing", log=self.logs / "feeder.log")
                if time.monotonic() > deadline:
                    raise RunFailed("the live feeder did not start within 60 s", log=self.logs / "feeder.log")
                time.sleep(0.5)
            say(f"live feeder writing; warming up for {LIVE_WARMUP_SECONDS} s")
            time.sleep(LIVE_WARMUP_SECONDS)
            self.playwright_pass("pass 2", "--grep")
        finally:
            stop_child(feeder, ledger=self.ledger)
        return live_since

    async def _final_checks(self, live_since: datetime | None) -> list[str]:
        problems = []
        conn = await asyncpg.connect(asyncpg_dsn(self.url))
        try:
            problems += await _drop_problems(conn)
            if live_since is not None:
                problems += await _live_ip_problems(conn, live_since)
        finally:
            await conn.close()
        client = LapiClient(self.lapi)
        try:
            foreign = foreign_decisions(await client.decision_values(self.config.bouncer_key), self.fixture)
        finally:
            await client.aclose()
        if foreign:
            problems.append(f"LAPI holds decisions for non-fixture values: {', '.join(foreign)}")
        return problems

    # Step 12
    def hold(self, failure: Exception | None) -> None:
        reason = (failure.args[0] if failure.args else repr(failure)) if failure is not None else ""
        outcome = f"capture failed: {reason}" if failure is not None else "capture done"
        say(outcome)
        say(f"PNGs: {self.png_dir}")
        port = self.config.app_port
        say(f"instance: http://{socket.gethostname()}.lan:{port}/ and http://127.0.0.1:{port}/")
        say("login: admin / admin")
        try:
            input("Enter goes on, Ctrl-C tears down: ")
        except EOFError:
            pass

    # Step 13
    def encode(self) -> dict[str, tuple[int, int]]:
        if not ENCODER.is_file():
            raise RunFailed(f"{ENCODER.relative_to(REPO_ROOT)} does not exist yet; nothing was encoded or published")
        webp_dir = self.run_dir / "webp"
        webp_dir.mkdir()
        code = self.runner.run(
            bun_argv(self.runner.which("bun"), str(ENCODER), str(self.png_dir), str(webp_dir)),
            label="encode",
            log="encode.log",
            stdout="encode.json",
        )
        if code != 0:
            raise RunFailed(f"the encoder exited {code}", log=self.logs / "encode.log")
        encoded = json.loads((self.logs / "encode.json").read_text())
        missing = [shot.name for shot in self.shots if shot.name not in encoded]
        if missing:
            raise RunFailed(f"the encoder left out {', '.join(missing)}")
        total = sum(int(encoded[shot.name]["bytes"]) for shot in self.shots)
        say(f"{len(self.shots)} encoded, {total / 1e6:.1f} MB")
        return {shot.name: (int(encoded[shot.name]["width"]), int(encoded[shot.name]["height"])) for shot in self.shots}

    # Step 14
    def publish(self, sizes: dict[str, tuple[int, int]]) -> None:
        webp_dir = self.run_dir / "webp"
        retaken = set(self.args.only) if self.args.only else None
        previous_path = DATA_SCREENSHOTS / "manifest.json"
        previous = json.loads(previous_path.read_text()) if previous_path.is_file() else None
        manifest = build_manifest(self.shots, sizes, previous=previous, retaken=retaken)
        (webp_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        new_files = {shot_filename(shot.scene.id, shot.viewport, shot.theme) for shot in self.shots}
        existing = {entry.name for entry in DATA_SCREENSHOTS.iterdir()} if DATA_SCREENSHOTS.is_dir() else set()
        plan = plan_swap(existing, new_files, retaken=retaken)
        stage_publish(DATA_SCREENSHOTS, plan, webp_dir)
        publish_staged(DATA_SCREENSHOTS)
        written = len(plan.write)
        total = sum((DATA_SCREENSHOTS / name).stat().st_size for name in plan.write)
        say(
            f"published {written} written ({written - 1} images and manifest.json), {len(plan.drop)} dropped, "
            f"{len(plan.keep)} kept, {total / 1e6:.1f} MB written"
        )


async def _drop_problems(conn: asyncpg.Connection) -> list[str]:
    problems = []
    if not await drop_marker_intact(conn):
        problems.append("the DROP lists no longer hold the fixture import: the app tried a real download")
    listed = await documentation_only_drop_lists(conn)
    if listed:
        problems.append(f"DROP lists hold non-documentation entries: {', '.join(listed)}")
    return problems


# The fixture step's documentation visitors are history too, but the feeder
# replays only seed visitors, so a live documentation address is a stranger.
LIVE_STRANGERS_SQL: Final = """
SELECT host(live.ip_address) AS ip
FROM (SELECT DISTINCT ip_address FROM access_logs WHERE timestamp >= $1) AS live
WHERE NOT EXISTS (
    SELECT 1 FROM access_logs AS history
    WHERE history.ip_address = live.ip_address
      AND history.timestamp < $1
      AND NOT history.ip_address <<= ANY($2::text[]::inet[])
)
ORDER BY 1
"""


async def _live_ip_problems(conn: asyncpg.Connection, live_since: datetime) -> list[str]:
    """The feeder must replay the seeded visitors; a live IP the history lacks means it drifted from the seed."""
    live = await conn.fetchval("SELECT count(*) FROM access_logs WHERE timestamp >= $1", live_since)
    if not live:
        return ["the app ingested no live requests while the feeder ran"]
    strangers = [row["ip"] for row in await conn.fetch(LIVE_STRANGERS_SQL, live_since, list(DOCUMENTATION_NETWORKS))]
    if strangers:
        return [f"live requests came from {len(strangers)} IPs the seed never wrote: {', '.join(strangers[:10])}"]
    return []
