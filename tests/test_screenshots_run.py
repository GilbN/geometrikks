"""The orchestrator's control flow: the browser sweep, recovery and teardown, cleanup, holds and refusals."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
from collections.abc import Callable, Generator, Iterator, Sequence
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, ClassVar, Literal, Self, cast

import pytest

from tests.screenshots import run, teardown
from tests.screenshots.environment import RunConfig, preflight_problems
from tests.screenshots.teardown import RESERVED_DATABASE, Ledger, Resource

ADMIN_URL = "postgresql://geouser:geopass@localhost:5432/postgres"
MARKER = b"SHOTS_PLAN=/run/plan.json"


# --- the browser sweep -------------------------------------------------------------------------------------


def proc_entry(proc: Path, pid: int, environ: bytes) -> None:
    (proc / str(pid)).mkdir(parents=True)
    (proc / str(pid) / "environ").write_bytes(environ)


@dataclass
class FakePidfds:
    proc: Path
    on_open: Callable[[int], None] | None = None
    open_error: OSError | None = None
    exits_before: int | None = None
    """The first signal number the inspected process is already gone for."""
    kill_error: OSError | None = None
    opened: list[int] = field(default_factory=list)
    sent: list[int] = field(default_factory=list)
    fds: list[int] = field(default_factory=list)

    def pidfd_open(self, pid: int, flags: int = 0) -> int:
        if self.open_error is not None:
            raise self.open_error
        self.opened.append(pid)
        if self.on_open is not None:
            self.on_open(pid)
        fd = os.open(os.devnull, os.O_RDONLY)
        self.fds.append(fd)
        return fd

    def pidfd_send_signal(self, fd: int, sig: int, siginfo: object = None, flags: int = 0) -> None:
        if self.exits_before is not None and sig >= self.exits_before:
            # A pidfd keeps naming the process it was opened for, so once that one exits the call fails,
            # even when the pid already belongs to someone else.
            raise ProcessLookupError(3, "No such process")
        if self.kill_error is not None:
            raise self.kill_error
        self.sent.append(sig)


@pytest.fixture
def pidfds(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[FakePidfds]:
    fake = FakePidfds(tmp_path / "proc")
    fake.proc.mkdir()
    killed: list[tuple[int, int]] = []
    monkeypatch.setattr(run.os, "pidfd_open", fake.pidfd_open)
    monkeypatch.setattr(run.signal, "pidfd_send_signal", fake.pidfd_send_signal)
    monkeypatch.setattr(run.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    yield fake
    assert killed == [], "the sweep must signal through a pidfd, never by pid"


def sweep(fake: FakePidfds) -> tuple[list[str], bool]:
    return run.sweep_marked(lambda pair: pair == MARKER, proc_root=fake.proc)


def test_sweep_kills_a_marked_process_through_its_pidfd(pidfds: FakePidfds) -> None:
    proc_entry(pidfds.proc, 4242, MARKER + b"\0PATH=/bin\0")
    proc_entry(pidfds.proc, 4343, b"PATH=/bin\0")
    assert sweep(pidfds) == (["stopped stray process 4242 from a capture"], False)
    assert signal.SIGKILL in pidfds.sent
    for fd in pidfds.fds:
        with pytest.raises(OSError):
            os.fstat(fd)


def test_sweep_never_signals_a_pid_reused_after_inspection(pidfds: FakePidfds) -> None:
    proc_entry(pidfds.proc, 4242, MARKER + b"\0")
    pidfds.exits_before = signal.SIGKILL
    assert sweep(pidfds) == ([], False)
    assert signal.SIGKILL not in pidfds.sent


def test_sweep_never_signals_a_pid_reused_before_its_pidfd_opened(pidfds: FakePidfds) -> None:
    proc_entry(pidfds.proc, 4242, MARKER + b"\0")

    def reused(pid: int) -> None:
        (pidfds.proc / str(pid) / "environ").write_bytes(b"PATH=/bin\0")

    pidfds.on_open = reused
    assert sweep(pidfds) == ([], False)
    assert signal.SIGKILL not in pidfds.sent


def test_sweep_skips_a_candidate_whose_pidfd_cannot_open(pidfds: FakePidfds) -> None:
    proc_entry(pidfds.proc, 4242, MARKER + b"\0")
    pidfds.open_error = ProcessLookupError(3, "No such process")
    assert sweep(pidfds) == ([], False)
    assert pidfds.sent == []


def test_sweep_reports_a_kill_that_failed_for_a_live_process(pidfds: FakePidfds) -> None:
    proc_entry(pidfds.proc, 4242, MARKER + b"\0")
    proc_entry(pidfds.proc, 4343, MARKER + b"\0")
    pidfds.kill_error = PermissionError(1, "Operation not permitted")
    lines, failed = sweep(pidfds)
    assert failed
    assert sorted(lines) == [
        "could not stop stray process 4242 from a capture: [Errno 1] Operation not permitted",
        "could not stop stray process 4343 from a capture: [Errno 1] Operation not permitted",
    ]


# --- full run and cleanup, with fake teardown actions ------------------------------------------------------


@dataclass
class FakeActions:
    ledger_path: Path
    labels: dict[str, str] = field(default_factory=dict)
    start_times: dict[int, str] = field(default_factory=dict)
    errors: dict[str, Exception] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)
    ledger_at_first_call: list[Resource] | None = None

    def _act(self, call: str) -> None:
        if self.ledger_at_first_call is None:
            self.ledger_at_first_call = Ledger(self.ledger_path).load()
        self.calls.append(call)
        if call in self.errors:
            raise self.errors[call]

    def process_start_time(self, pid: int) -> str | None:
        self._act(f"process_start_time {pid}")
        return self.start_times.get(pid)

    def group_alive(self, pgid: int) -> bool:
        return False

    def group_has_token(self, pgid: int, token: str) -> bool:
        return False

    def stop_process(self, pgid: int, *, start_time: str = "", token: str = "") -> None:
        self._act(f"stop_process {pgid}")

    def run_label(self, kind: Literal["container", "network"], name: str) -> str | None:
        self._act(f"run_label {name}")
        return self.labels.get(name)

    def remove_container(self, name: str) -> None:
        self._act(f"remove_container {name}")

    def remove_network(self, name: str) -> None:
        self._act(f"remove_network {name}")

    def drop_database(self, name: str, admin_url: str) -> None:
        self._act(f"drop_database {name}")

    def remove_directory(self, path: Path) -> None:
        self._act(f"remove_directory {path}")
        shutil.rmtree(path)


@dataclass
class Isolated:
    root: Path
    ledger_path: Path
    screenshots: Path
    actions: FakeActions


@pytest.fixture
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Isolated:
    root = tmp_path / "root"
    root.mkdir()
    actions = FakeActions(root / "ledger.json")
    monkeypatch.setattr(run, "RUN_ROOT", root)
    monkeypatch.setattr(run, "LEDGER_PATH", root / "ledger.json")
    monkeypatch.setattr(run, "DATA_SCREENSHOTS", tmp_path / "screenshots")
    monkeypatch.setattr(run, "SystemActions", lambda **_: actions)
    monkeypatch.setattr(run, "sweep_marked", lambda marker: ([], False))
    return Isolated(root, root / "ledger.json", tmp_path / "screenshots", actions)


def run_args(**overrides: object) -> argparse.Namespace:
    values: dict[str, object] = {
        "only": None,
        "hold": False,
        "own_db": False,
        "no_build": True,
        "pg_admin_url": ADMIN_URL,
        "city_db": Path("/geo/city.mmdb"),
        "asn_db": Path("/geo/asn.mmdb"),
        "carto_key": "k",
    }
    return argparse.Namespace(**{**values, **overrides})


class QuietRun:
    def __init__(self, args: argparse.Namespace, **_: object) -> None:
        pass

    def execute(self) -> None:
        pass


class NeverStarted:
    def __init__(self, args: argparse.Namespace, **_: object) -> None:
        raise AssertionError("the run started")


def failing_second_recovery(calls: list[Path]) -> Callable[[Path], list[str]]:
    def recover(target: Path) -> list[str]:
        calls.append(target)
        if len(calls) == 2:
            raise OSError("rename failed")
        return []

    return recover


def test_full_run_tears_down_when_publish_recovery_fails(
    isolated: Isolated, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls: list[Path] = []
    monkeypatch.setattr(run, "recover_publish", failing_second_recovery(calls))
    monkeypatch.setattr(run, "FullRun", QuietRun)
    code = run.full_run(run_args())
    out = capsys.readouterr().out
    assert code == run.EXIT_FAILED
    assert "publish recovery failed: rename failed" in out
    assert not list(isolated.root.glob("run-*")) and not isolated.ledger_path.exists()
    assert "teardown: done" in out


def test_full_run_keeps_an_interrupt_exit_when_recovery_also_fails(
    isolated: Isolated, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Interrupting(QuietRun):
        def execute(self) -> None:
            raise teardown.Interrupted(signal.SIGTERM)

    monkeypatch.setattr(run, "recover_publish", failing_second_recovery([]))
    monkeypatch.setattr(run, "FullRun", Interrupting)
    assert run.full_run(run_args()) == run.EXIT_INTERRUPTED
    assert not list(isolated.root.glob("run-*"))


def test_a_signal_while_reporting_a_failure_still_tears_down(
    isolated: Isolated, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    class Failing(QuietRun):
        def execute(self) -> None:
            raise run.RunFailed("boom", log=isolated.root / "missing.log")

    def signalling_tail(path: Path, lines: int = run.LOG_TAIL_LINES) -> str:
        os.kill(os.getpid(), signal.SIGTERM)
        return ""

    class Escaped(Exception):
        pass

    def outside(signum: int, frame: object) -> None:
        raise Escaped

    monkeypatch.setattr(run, "FullRun", Failing)
    monkeypatch.setattr(run, "_tail", signalling_tail)
    previous = signal.signal(signal.SIGTERM, outside)
    try:
        code = run.full_run(run_args())
    finally:
        signal.signal(signal.SIGTERM, previous)
    assert code == run.EXIT_INTERRUPTED
    assert not list(isolated.root.glob("run-*"))
    assert "interrupted by SIGTERM" in capsys.readouterr().out


@pytest.mark.parametrize("manifest", [None, "not json", '{"version": 1}'])
def test_a_retake_without_a_readable_manifest_starts_nothing(
    isolated: Isolated, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], manifest: str | None
) -> None:
    if manifest is not None:
        isolated.screenshots.mkdir()
        (isolated.screenshots / "manifest.json").write_text(manifest)
    monkeypatch.setattr(run, "FullRun", NeverStarted)
    assert run.full_run(run_args(only=["map"])) == run.EXIT_REFUSED
    assert "run a full run first" in capsys.readouterr().out
    assert not list(isolated.root.iterdir())


def test_retake_problem_accepts_a_manifest_with_scenes(isolated: Isolated) -> None:
    isolated.screenshots.mkdir()
    (isolated.screenshots / "manifest.json").write_text(json.dumps({"version": 1, "scenes": {}}))
    assert run._retake_problem(["map"]) is None
    assert run._retake_problem(None) is None


def labelled_found(found: list[tuple[str, str, str]]) -> Callable[[object], list[tuple[str, str, str]]]:
    return lambda runner: list(found)


def database_check(exists: bool | Exception) -> Callable[[str], object]:
    async def check(admin_url: str) -> bool:
        if isinstance(exists, Exception):
            raise exists
        return exists

    return check


LABELLED = [("container", "geometrikks-shots-crowdsec", "r9"), ("network", "geometrikks-shots-net", "r9")]


@pytest.fixture
def discovered(isolated: Isolated, monkeypatch: pytest.MonkeyPatch) -> Isolated:
    monkeypatch.setattr(run, "recover_publish", lambda target: [])
    monkeypatch.setattr(run, "_labelled", labelled_found(LABELLED))
    monkeypatch.setattr(run, "_database_exists", database_check(True))
    isolated.actions.labels = {"geometrikks-shots-crowdsec": "r9", "geometrikks-shots-net": "r9"}
    return isolated


def test_cleanup_writes_what_it_discovers_to_the_ledger_before_teardown(
    discovered: Isolated, capsys: pytest.CaptureFixture[str]
) -> None:
    assert run.cleanup(run_args()) == run.EXIT_DONE
    assert discovered.actions.ledger_at_first_call == [
        Resource("container", "geometrikks-shots-crowdsec", (("run_id", "r9"),)),
        Resource("network", "geometrikks-shots-net", (("run_id", "r9"),)),
        Resource("database", RESERVED_DATABASE, (("admin_url", ADMIN_URL),)),
    ]
    assert not discovered.ledger_path.exists()
    assert "cleanup: nothing left" in capsys.readouterr().out


def test_cleanup_fails_while_a_discovered_resource_remains(
    discovered: Isolated, capsys: pytest.CaptureFixture[str]
) -> None:
    discovered.actions.errors["remove_container geometrikks-shots-crowdsec"] = RuntimeError("busy")
    assert run.cleanup(run_args()) == run.EXIT_FAILED
    assert Ledger(discovered.ledger_path).load() == [
        Resource("container", "geometrikks-shots-crowdsec", (("run_id", "r9"),))
    ]
    out = capsys.readouterr().out
    assert "busy" in out and "nothing left" not in out


@pytest.mark.parametrize(
    "broken",
    [
        {"_labelled": lambda runner: (_ for _ in ()).throw(run.RunFailed("docker list containers exited 1"))},
        {"_database_exists": database_check(OSError("connection refused"))},
    ],
    ids=["labelled-listing", "database-check"],
)
def test_cleanup_fails_when_discovery_fails(
    discovered: Isolated,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    broken: dict[str, object],
) -> None:
    for name, value in broken.items():
        monkeypatch.setattr(run, name, value)
    assert run.cleanup(run_args()) == run.EXIT_FAILED
    assert "nothing left" not in capsys.readouterr().out


def test_cleanup_reports_a_recovery_failure_and_still_cleans(
    discovered: Isolated, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def broken(target: Path) -> list[str]:
        raise OSError("rename failed")

    monkeypatch.setattr(run, "recover_publish", broken)
    assert run.cleanup(run_args()) == run.EXIT_FAILED
    out = capsys.readouterr().out
    assert "publish recovery failed: rename failed" in out and "nothing left" not in out
    assert "remove_container geometrikks-shots-crowdsec" in discovered.actions.calls
    assert not discovered.ledger_path.exists()


def test_cleanup_with_nothing_to_remove_leaves_no_empty_ledger(
    isolated: Isolated, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def listing_leaves_an_empty_ledger(runner: run.Runner) -> list[tuple[str, str, str]]:
        runner.ledger.add(Resource("process", "4242", (("label", "docker list"),)))
        runner.ledger.discard(Resource("process", "4242"))
        return []

    monkeypatch.setattr(run, "recover_publish", lambda target: [])
    monkeypatch.setattr(run, "_labelled", listing_leaves_an_empty_ledger)
    monkeypatch.setattr(run, "_database_exists", database_check(False))
    assert run.cleanup(run_args()) == run.EXIT_DONE
    assert "nothing left" in capsys.readouterr().out
    assert sorted(entry.name for entry in isolated.root.iterdir()) == []


def test_teardown_keeps_an_unreadable_ledger(isolated: Isolated) -> None:
    isolated.ledger_path.write_text("{")
    assert run._teardown([], Ledger(isolated.ledger_path), {}, isolated.root) == []
    assert isolated.ledger_path.read_text() == "{"


def dry_folder(root: Path, pid: int) -> Path:
    folder = root / f"dry-{pid}"
    folder.mkdir()
    Ledger(folder / "ledger.json").add(
        Resource("process", str(pid), (("label", "playwright --list"), ("start_time", "7"), ("token", "t")))
    )
    return folder


def test_cleanup_removes_a_dry_run_folder_once_its_ledger_is_torn_down(
    discovered: Isolated, capsys: pytest.CaptureFixture[str]
) -> None:
    folder = dry_folder(discovered.root, 77777)
    discovered.actions.start_times[77777] = "7"
    assert run.cleanup(run_args()) == run.EXIT_DONE
    assert "stop_process 77777" in discovered.actions.calls
    assert not folder.exists()


def test_cleanup_keeps_a_dry_run_folder_whose_teardown_failed(
    discovered: Isolated, capsys: pytest.CaptureFixture[str]
) -> None:
    folder = dry_folder(discovered.root, 77777)
    discovered.actions.start_times[77777] = "7"
    discovered.actions.errors["stop_process 77777"] = OSError("still running")
    assert run.cleanup(run_args()) == run.EXIT_FAILED
    assert folder.is_dir() and Ledger(folder / "ledger.json").load()
    out = capsys.readouterr().out
    assert f"kept {folder}" in out and "nothing left" not in out


def test_cleanup_keeps_a_dry_run_folder_with_an_unreadable_ledger(
    discovered: Isolated, capsys: pytest.CaptureFixture[str]
) -> None:
    folder = discovered.root / "dry-1234"
    folder.mkdir()
    (folder / "ledger.json").write_text("{")
    assert run.cleanup(run_args()) == run.EXIT_FAILED
    assert folder.is_dir()
    assert f"kept {folder}" in capsys.readouterr().out


# --- the dry run's exit status ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("problems", "listed", "expected"),
    [
        ([], 0, run.EXIT_DONE),
        ([], 1, run.EXIT_FAILED),
        (["no CARTO key"], 1, run.EXIT_REFUSED),
        (["no CARTO key"], 0, run.EXIT_REFUSED),
    ],
)
def test_dry_run_exits_refused_on_problems_else_failed_when_the_list_fails(
    isolated: Isolated,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    problems: list[str],
    listed: int,
    expected: int,
) -> None:
    def fake_run(runner: run.Runner, argv: list[str], *, label: str, log: str, **_: object) -> int:
        (runner.log_dir / log).write_text("Error: unknown scene: nav-more\n" if listed else "Total: 72 tests\n")
        return listed

    monkeypatch.setattr(run, "gather_facts", lambda args, runner, ledger_exists: None)
    monkeypatch.setattr(run, "preflight_problems", lambda facts: list(problems))
    monkeypatch.setattr(run.Runner, "which", lambda runner, name: f"/usr/bin/{name}")
    monkeypatch.setattr(run.Runner, "run", fake_run)
    assert run.dry_run(run_args()) == expected
    out = capsys.readouterr().out
    assert f"playwright --list exited {listed}" in out
    assert not list(isolated.root.glob("dry-*"))


# --- steps 8 and 12, the shared helper, and the preflight --------------------------------------------------


class FakeConn:
    async def close(self) -> None:
        pass


def test_app_start_check_refuses_non_documentation_drop_entries(monkeypatch: pytest.MonkeyPatch) -> None:
    async def connect(dsn: str) -> FakeConn:
        return FakeConn()

    async def intact(conn: object) -> bool:
        return True

    async def listed(conn: object) -> list[str]:
        return ["192.0.2.77/32"]

    monkeypatch.setattr(run.asyncpg, "connect", connect)
    monkeypatch.setattr(run, "drop_marker_intact", intact)
    monkeypatch.setattr(run, "documentation_only_drop_lists", listed)
    full = object.__new__(run.FullRun)
    full.url = "postgresql+asyncpg://geouser:geopass@localhost:5432/geometrikks_screenshots"
    with pytest.raises(run.RunFailed, match=r"^DROP lists hold non-documentation entries: 192\.0\.2\.77/32$"):
        full.check_drop_lists()


class HeldRun(run.FullRun):
    def __init__(self, failure: Exception) -> None:
        self.args = run_args(hold=True)
        self.png_dir = Path("/x/png")
        self.config = RunConfig(
            run_id="r1",
            pg_admin_url=ADMIN_URL,
            own_db=False,
            app_port=1234,
            bouncer_key="b",
            machine_password="m",
            city_db=Path("/geo/city.mmdb"),
            asn_db=Path("/geo/asn.mmdb"),
            carto_key="k",
            live_dir=Path("/x/live"),
        )
        self.failure = failure
        self.encoded = False

    def capture(self) -> None:
        raise self.failure

    def encode(self) -> dict[str, tuple[int, int]]:
        self.encoded = True
        return {}


def test_hold_keeps_any_capture_failure(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    held = HeldRun(ValueError())
    monkeypatch.setattr("builtins.input", lambda prompt: "")
    with pytest.raises(ValueError):
        held.capture_and_publish()
    assert "capture failed: ValueError()" in capsys.readouterr().out
    assert not held.encoded


def test_run_shares_the_teardown_child_check() -> None:
    assert run._child_exited is teardown._child_exited


def no_docker(tmp_path: Path) -> run.Runner:
    return run.Runner(ledger=Ledger(tmp_path / "ledger.json"), env={"PATH": ""}, log_dir=tmp_path)


def test_preflight_reports_an_unreachable_database_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(run, "_database_exists", database_check(OSError("connection refused")))
    facts = run.gather_facts(run_args(), no_docker(tmp_path), ledger_exists=False)
    assert facts.database_reachable is False
    assert any("--own-db" in problem and "does not answer" in problem for problem in preflight_problems(facts))


def test_preflight_skips_the_shared_server_with_own_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(run, "_database_exists", database_check(OSError("connection refused")))
    facts = run.gather_facts(run_args(own_db=True), no_docker(tmp_path), ledger_exists=False)
    assert facts.database_reachable is True


ABUSEIPDB_OFF: dict[str, object] = {"enabled": False, "reportingEnabled": False, "blacklistEnabled": False}


class HealthyClient:
    abuseipdb_status: ClassVar[dict[str, object]] = ABUSEIPDB_OFF

    def __init__(self, **_: object) -> None:
        pass

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        pass

    def get(self, path: str) -> SimpleResponse:
        if path == "/api/v1/abuseipdb/status":
            return SimpleResponse(200, self.abuseipdb_status)
        return SimpleResponse(200)

    def post(self, path: str, json: object) -> SimpleResponse:
        return SimpleResponse(200)


@dataclass
class FakeChild:
    pid: int


@dataclass
class SimpleResponse:
    status_code: int
    body: dict[str, object] = field(default_factory=dict)

    @property
    def is_success(self) -> bool:
        return self.status_code < 400

    @property
    def text(self) -> str:
        return json.dumps(self.body)

    def json(self) -> dict[str, object]:
        return self.body


class AppStart(HeldRun):
    def __init__(self, tmp_path: Path) -> None:
        super().__init__(ValueError())
        self.config = replace(self.config, live_dir=tmp_path / "live")
        self.logs = tmp_path
        self.ledger = Ledger(tmp_path / "ledger.json")
        self.lapi = "http://172.30.0.2:8080"

    def check_drop_lists(self) -> None:
        raise run.RunFailed("DROP lists hold non-documentation entries: 192.0.2.77/32")


def test_app_start_runs_the_drop_check_before_reporting_healthy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(run, "start_child", lambda argv, **_: FakeChild(4242))
    monkeypatch.setattr(run, "_child_exited", lambda pid: False)
    monkeypatch.setattr(run.httpx2, "Client", HealthyClient)
    with pytest.raises(run.RunFailed, match="non-documentation"):
        AppStart(tmp_path).start_app()
    assert "app healthy" not in capsys.readouterr().out


class KeyedClient(HealthyClient):
    abuseipdb_status: ClassVar[dict[str, object]] = {**ABUSEIPDB_OFF, "enabled": True}


def test_app_start_fails_when_the_server_has_an_abuseipdb_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(run, "start_child", lambda argv, **_: FakeChild(4242))
    monkeypatch.setattr(run, "_child_exited", lambda pid: False)
    monkeypatch.setattr(run.httpx2, "Client", KeyedClient)
    with pytest.raises(run.RunFailed, match="AbuseIPDB is not off on the server"):
        AppStart(tmp_path).start_app()
    assert "app healthy" not in capsys.readouterr().out


# --- the final fix round: exit status after teardown, cleanup, interrupt window, Bun and Vite dotenv ------


def test_a_published_run_fails_when_teardown_leaves_its_resources(
    isolated: Isolated, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    class Published(QuietRun):
        def __init__(self, args: argparse.Namespace, *, ledger: Ledger, run_id: str, **_: object) -> None:
            self.ledger = ledger
            self.run_id = run_id

        def execute(self) -> None:
            container = Resource("container", "geometrikks-shots-crowdsec", (("run_id", self.run_id),))
            self.ledger.add(container)
            self.ledger.mark_acquired(container)

    def labels(kind: str, name: str) -> str | None:
        return next(entry.meta_value("run_id") for entry in Ledger(isolated.ledger_path).load() if entry.ident == name)

    monkeypatch.setattr(run, "recover_publish", lambda target: [])
    monkeypatch.setattr(run, "FullRun", Published)
    monkeypatch.setattr(isolated.actions, "run_label", labels)
    isolated.actions.errors["remove_container geometrikks-shots-crowdsec"] = RuntimeError("busy")
    assert run.full_run(run_args()) == run.EXIT_FAILED
    out = capsys.readouterr().out
    assert "busy" in out and "the ledger still lists resources" in out
    assert [entry.ident for entry in Ledger(isolated.ledger_path).load()] == ["geometrikks-shots-crowdsec"]


def test_a_published_run_fails_when_a_stray_capture_process_survives(
    isolated: Isolated, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(run, "recover_publish", lambda target: [])
    monkeypatch.setattr(run, "FullRun", QuietRun)
    monkeypatch.setattr(run, "sweep_marked", lambda marker: (["could not stop stray process 4242"], True))
    assert run.full_run(run_args()) == run.EXIT_FAILED


def test_cleanup_fails_when_a_stray_process_cannot_be_killed(
    discovered: Isolated, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(run, "sweep_marked", lambda marker: (["could not stop stray process 4242"], True))
    assert run.cleanup(run_args()) == run.EXIT_FAILED
    out = capsys.readouterr().out
    assert "could not stop stray process 4242" in out and "nothing left" not in out


def test_cleanup_with_own_db_never_asks_the_shared_server(
    discovered: Isolated, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    asked: list[str] = []

    async def check(admin_url: str) -> bool:
        asked.append(admin_url)
        raise OSError("connection refused")

    monkeypatch.setattr(run, "_database_exists", check)
    assert run.cleanup(run_args(own_db=True)) == run.EXIT_DONE
    assert asked == []
    assert discovered.actions.ledger_at_first_call is not None
    assert all(entry.kind != "database" for entry in discovered.actions.ledger_at_first_call)
    assert "cleanup: nothing left" in capsys.readouterr().out


class Escaped(Exception):
    pass


def escape(signum: int, frame: object) -> None:
    raise Escaped


@contextmanager
def signal_after_raise_block(real: Callable[[], AbstractContextManager[None]]) -> Generator[None]:
    with real():
        yield
    os.kill(os.getpid(), signal.SIGTERM)


def test_a_signal_between_the_run_and_its_teardown_is_ignored(
    isolated: Isolated, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = run.interrupts_raise
    monkeypatch.setattr(run, "interrupts_raise", lambda: signal_after_raise_block(real))
    monkeypatch.setattr(run, "recover_publish", lambda target: [])
    monkeypatch.setattr(run, "FullRun", QuietRun)
    previous = signal.signal(signal.SIGTERM, escape)
    try:
        code = run.full_run(run_args())
    finally:
        signal.signal(signal.SIGTERM, previous)
    assert code == run.EXIT_DONE
    assert not list(isolated.root.glob("run-*"))


def test_a_signal_between_the_dry_run_and_its_teardown_is_ignored(
    isolated: Isolated, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_run(runner: run.Runner, argv: list[str], *, label: str, log: str, **_: object) -> int:
        (runner.log_dir / log).write_text("Total: 72 tests\n")
        return 0

    real = run.interrupts_raise
    monkeypatch.setattr(run, "interrupts_raise", lambda: signal_after_raise_block(real))
    monkeypatch.setattr(run, "gather_facts", lambda args, runner, ledger_exists: None)
    monkeypatch.setattr(run, "preflight_problems", lambda facts: [])
    monkeypatch.setattr(run.Runner, "which", lambda runner, name: f"/usr/bin/{name}")
    monkeypatch.setattr(run.Runner, "run", fake_run)
    previous = signal.signal(signal.SIGTERM, escape)
    try:
        code = run.dry_run(run_args())
    finally:
        signal.signal(signal.SIGTERM, previous)
    assert code == run.EXIT_DONE
    assert not list(isolated.root.glob("dry-*"))


@dataclass
class RecordingRunner:
    log_dir: Path
    calls: list[tuple[list[str], dict[str, str] | None]] = field(default_factory=list)
    stdout: str = ""

    def which(self, name: str) -> str:
        return f"/usr/bin/{name}"

    def run(
        self, argv: Sequence[str], *, label: str, log: str, env: dict[str, str] | None = None, stdout: str | None = None
    ) -> int:
        self.calls.append((list(argv), env))
        if stdout:
            (self.log_dir / stdout).write_text(self.stdout)
        return 0

    def capture(self, argv: Sequence[str], *, label: str) -> tuple[int, str]:
        return 0, ""


def bare_run(tmp_path: Path) -> tuple[run.FullRun, RecordingRunner]:
    full = object.__new__(run.FullRun)
    full.run_dir = tmp_path / "run"
    full.logs = full.run_dir / "logs"
    full.logs.mkdir(parents=True)
    full.png_dir = full.run_dir / "png"
    full.env = {"PATH": "/usr/bin", "GEOMETRIKKS_ENV_FILE": ""}
    full.shots = []
    runner = RecordingRunner(full.logs)
    full.runner = cast(run.Runner, runner)
    return full, runner


def test_the_build_runs_vite_through_the_wrapper_config_with_an_empty_env_dir(tmp_path: Path) -> None:
    full, runner = bare_run(tmp_path)
    full.build()
    [(argv, env)] = runner.calls
    assert argv == ["/usr/bin/bun", "--no-env-file", "run", "vite", "build", f"--config={run.SCREENSHOT_VITE_CONFIG}"]
    assert run.SCREENSHOT_VITE_CONFIG.is_file()
    assert env is not None
    env_dir = Path(env[run.VITE_ENV_DIR_VAR])
    assert env_dir.is_relative_to(full.run_dir) and env_dir.is_dir() and not list(env_dir.iterdir())
    assert {name: value for name, value in env.items() if name != run.VITE_ENV_DIR_VAR} == full.env


def test_the_encoder_runs_without_dotenv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    full, runner = bare_run(tmp_path)
    encoder = tmp_path / "encode.ts"
    encoder.write_text("")
    monkeypatch.setattr(run, "ENCODER", encoder)
    runner.stdout = "{}"
    full.encode()
    [(argv, _)] = runner.calls
    assert argv[:3] == ["/usr/bin/bun", "--no-env-file", str(encoder)]


SENTINEL = "http://sentinel.invalid"
PRINT_LAPI = 'console.log(process.env.CROWDSEC_LAPI_URL ?? "")'
BUN = shutil.which("bun")
NODE = shutil.which("node")


def dotenv_folder(tmp_path: Path) -> Path:
    folder = tmp_path / "checkout"
    folder.mkdir()
    (folder / ".env").write_text(f"CROWDSEC_LAPI_URL={SENTINEL}\nVITE_SHOTS_SENTINEL={SENTINEL}\n")
    (folder / ".env.production").write_text(f"VITE_SHOTS_SENTINEL_PRODUCTION={SENTINEL}\n")
    (folder / "package.json").write_text(json.dumps({"scripts": {"show": f"node -e '{PRINT_LAPI}'"}}))
    return folder


def child_output(argv: Sequence[str], cwd: Path, **extra: str) -> str:
    env = {"PATH": os.environ["PATH"], "HOME": str(cwd), **extra}
    return subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=60, check=True).stdout


@pytest.mark.skipif(BUN is None or NODE is None, reason="needs bun and node")
def test_bun_children_never_see_a_dotenv_file(tmp_path: Path) -> None:
    assert BUN is not None
    folder = dotenv_folder(tmp_path)
    # The probe can see the file at all: Bun without the flag loads it.
    assert SENTINEL in child_output([BUN, "-e", PRINT_LAPI], folder)
    assert SENTINEL not in child_output(run.bun_argv(BUN, "-e", PRINT_LAPI), folder)
    assert SENTINEL not in child_output(run.bun_argv(BUN, "run", "show"), folder)


VITE_ENTRY = run.REPO_ROOT / "node_modules" / "vite" / "dist" / "node" / "index.js"
RESOLVE_ENV = """
const { resolveConfig } = await import(process.argv[1]);
const config = await resolveConfig({ configFile: process.argv[2], logLevel: "silent" }, "build", "production");
console.log(JSON.stringify({ envDir: config.envDir, env: config.env }));
"""


def resolved_vite_env(config: Path, cwd: Path, **extra: str) -> dict[str, Any]:
    out = child_output([str(NODE), "--input-type=module", "-e", RESOLVE_ENV, str(VITE_ENTRY), str(config)], cwd, **extra)
    return json.loads(out.strip().splitlines()[-1])


@pytest.mark.skipif(NODE is None or not VITE_ENTRY.is_file(), reason="needs node and the root node_modules")
def test_the_screenshot_vite_config_reads_no_dotenv_file(tmp_path: Path) -> None:
    folder = dotenv_folder(tmp_path)
    empty = tmp_path / "vite-env"
    empty.mkdir()
    # The probe can see the files at all: the repo's own config loads them from its working directory.
    plain = resolved_vite_env(run.REPO_ROOT / "vite.config.ts", folder)
    assert {"VITE_SHOTS_SENTINEL", "VITE_SHOTS_SENTINEL_PRODUCTION"} <= set(plain["env"])
    wrapped = resolved_vite_env(run.SCREENSHOT_VITE_CONFIG, folder, **{run.VITE_ENV_DIR_VAR: str(empty)})
    assert wrapped["envDir"] == str(empty)
    assert SENTINEL not in json.dumps(wrapped["env"])


@pytest.mark.skipif(NODE is None or not VITE_ENTRY.is_file(), reason="needs node and the root node_modules")
def test_the_screenshot_vite_config_refuses_to_load_without_its_env_dir(tmp_path: Path) -> None:
    with pytest.raises(subprocess.CalledProcessError) as failure:
        resolved_vite_env(run.SCREENSHOT_VITE_CONFIG, dotenv_folder(tmp_path))
    assert run.VITE_ENV_DIR_VAR in failure.value.stderr


class OrderedRun(HeldRun):
    def __init__(self, *, hold: bool, check_fails: bool = False) -> None:
        super().__init__(ValueError())
        self.args = run_args(hold=hold)
        self.steps: list[str] = []
        self.check_fails = check_fails

    def capture(self) -> None:
        self.steps.append("capture")

    def hold(self, failure: Exception | None) -> None:
        self.steps.append("hold")

    def stop_app(self) -> None:
        self.steps.append("stop app")

    def check_abuseipdb(self) -> None:
        self.steps.append("check AbuseIPDB")
        if self.check_fails:
            raise run.RunFailed("the app log shows 1 AbuseIPDB lines: abuseipdb_check")

    def encode(self) -> dict[str, tuple[int, int]]:
        self.steps.append("encode")
        return {}

    def publish(self, sizes: dict[str, tuple[int, int]]) -> None:
        self.steps.append("publish")


def test_the_abuseipdb_check_runs_after_the_hold_and_the_app_stop_and_before_publishing() -> None:
    held = OrderedRun(hold=True)
    held.capture_and_publish()
    assert held.steps == ["capture", "hold", "stop app", "check AbuseIPDB", "encode", "publish"]


def test_a_failed_abuseipdb_check_blocks_the_publish() -> None:
    failing = OrderedRun(hold=False, check_fails=True)
    with pytest.raises(run.RunFailed, match="AbuseIPDB lines"):
        failing.capture_and_publish()
    assert failing.steps == ["capture", "stop app", "check AbuseIPDB"]


def test_stop_app_fails_the_run_when_the_app_had_to_be_killed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    killed = AppStart(tmp_path)
    killed.app = cast(Any, FakeChild(4242))
    monkeypatch.setattr(run, "stop_child_gracefully", lambda child, **_: None)
    with pytest.raises(run.RunFailed, match="did not stop within 30 s"):
        killed.stop_app()


def test_check_abuseipdb_reads_the_whole_app_log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    checked = AppStart(tmp_path)
    (tmp_path / "app.log").write_text("app_started\n2026-11-12 warning abuseipdb_blacklist_refresh_failed\n")

    async def no_stored_problems(self: run.FullRun) -> list[str]:
        return []

    monkeypatch.setattr(run.FullRun, "_stored_abuseipdb_problems", no_stored_problems)
    with pytest.raises(run.RunFailed, match="abuseipdb_blacklist_refresh_failed"):
        checked.check_abuseipdb()
