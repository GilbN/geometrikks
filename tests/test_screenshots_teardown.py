"""The screenshot run's lock, ledger, child processes and teardown, against fakes only."""

import os
import signal
import stat
import sys
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import pytest

from tests.screenshots.teardown import (
    REPO_ROOT,
    Interrupted,
    Ledger,
    Resource,
    RunLocked,
    SystemActions,
    acquire_run_lock,
    already_gone,
    ensure_run_root,
    execute_teardown,
    interrupts_deferred,
    interrupts_ignored,
    interrupts_raise,
    plan_teardown,
    proc_start_time,
    run_child,
    start_child,
    stop_child,
    wait_child,
)

CHILD_ENV = {"PATH": os.environ["PATH"]}


@dataclass
class FakeActions:
    start_times: dict[int, str] = field(default_factory=dict)
    alive_groups: set[int] = field(default_factory=set)
    labels: dict[str, str] = field(default_factory=dict)
    errors: dict[str, Exception] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)

    def _act(self, method: str, ident: object) -> None:
        call = f"{method} {ident}"
        self.calls.append(call)
        if call in self.errors:
            raise self.errors[call]

    def process_start_time(self, pid: int) -> str | None:
        return self.start_times.get(pid)

    def group_alive(self, pgid: int) -> bool:
        return pgid in self.alive_groups

    def stop_process(self, pgid: int) -> None:
        self._act("stop_process", pgid)

    def run_label(self, kind: Literal["container", "network"], name: str) -> str | None:
        return self.labels.get(name)

    def remove_container(self, name: str) -> None:
        self._act("remove_container", name)

    def remove_network(self, name: str) -> None:
        self._act("remove_network", name)

    def drop_database(self, name: str, admin_url: str) -> None:
        self._act("drop_database", name)

    def remove_directory(self, path: Path) -> None:
        self._act("remove_directory", path)


def ledger_with(path: Path, resources: Sequence[Resource]) -> Ledger:
    ledger = Ledger(path)
    for resource in resources:
        ledger.add(resource)
    return ledger


def test_plan_orders_processes_containers_networks_databases_dirs(tmp_path: Path) -> None:
    run = tmp_path / "run1"
    created = [
        Resource("database", "geometrikks_screenshots", (("admin_url", "postgresql://x"),)),
        Resource("network", "geometrikks-shots-net", (("run_id", "r1"),)),
        Resource("container", "geometrikks-shots-crowdsec", (("run_id", "r1"),)),
        Resource("directory", str(run)),
        Resource("process", "101", (("label", "app"),)),
        Resource("process", "202", (("label", "feeder"),)),
    ]
    assert [r.ident for r in plan_teardown(created, run_root=tmp_path)] == [
        "202",
        "101",
        "geometrikks-shots-crowdsec",
        "geometrikks-shots-net",
        "geometrikks_screenshots",
        str(run),
    ]


def test_plan_refuses_directories_outside_the_run_root(tmp_path: Path) -> None:
    for path in (Path.home(), tmp_path, tmp_path / "run1" / ".." / "..", Path("run1")):
        with pytest.raises(ValueError):
            plan_teardown([Resource("directory", str(path))], run_root=tmp_path)


def test_plan_refuses_a_database_it_does_not_own(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="geometrikks"):
        plan_teardown([Resource("database", "geometrikks", (("admin_url", "postgresql://x"),))], run_root=tmp_path)
    inside = Resource("database", "geometrikks", (("admin_url", "postgresql://x"), ("container", "geometrikks-shots-db")))
    with pytest.raises(ValueError, match="geometrikks"):
        plan_teardown([inside, Resource("container", "geometrikks-shots-db", (("run_id", "r1"),))], run_root=tmp_path)


def test_plan_refuses_containers_and_networks_it_does_not_own(tmp_path: Path) -> None:
    for kind, name in (("container", "timescale_db"), ("network", "bridge")):
        with pytest.raises(ValueError, match=name):
            plan_teardown([Resource(kind, name, (("run_id", "r1"),))], run_root=tmp_path)
    with pytest.raises(ValueError, match="run_id"):
        plan_teardown([Resource("container", "geometrikks-shots-crowdsec")], run_root=tmp_path)


def test_plan_refuses_process_groups_it_must_never_signal(tmp_path: Path) -> None:
    for ident in ("0", "1", "-5", "abc", str(os.getpgrp())):
        with pytest.raises(ValueError, match="process"):
            plan_teardown([Resource("process", ident, (("label", "x"), ("start_time", "1")))], run_root=tmp_path)


def test_ledger_round_trip_and_permissions(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "ledger.json")
    ledger.add(Resource("container", "a", state="intended"))
    ledger.add(Resource("process", "7"))
    ledger.mark_acquired(Resource("container", "a", state="intended"))
    assert [(r.ident, r.state) for r in Ledger(tmp_path / "ledger.json").load()] == [
        ("a", "acquired"),
        ("7", "acquired"),
    ]
    assert (tmp_path / "ledger.json").stat().st_mode & 0o777 == 0o600
    ledger.discard(Resource("container", "a"))
    ledger.discard(Resource("process", "7"))
    assert ledger.load() == []
    ledger.clear()
    assert not ledger.exists()
    assert list(tmp_path.iterdir()) == []


def test_ledger_keeps_meta_and_rejects_unknown_kinds(tmp_path: Path) -> None:
    resource = Resource("process", "7", (("label", "app"), ("start_time", "42")))
    ledger_with(tmp_path / "ledger.json", [resource])
    assert Ledger(tmp_path / "ledger.json").load() == [resource]
    (tmp_path / "bad.json").write_text('[{"kind": "volume", "ident": "x", "meta": [], "state": "acquired"}]')
    with pytest.raises(ValueError, match="volume"):
        Ledger(tmp_path / "bad.json").load()


def test_owned_lists_only_what_this_instance_added(tmp_path: Path) -> None:
    Ledger(tmp_path / "ledger.json").add(Resource("container", "geometrikks-shots-old", (("run_id", "r0"),)))
    ledger = Ledger(tmp_path / "ledger.json")
    ledger.add(Resource("container", "geometrikks-shots-crowdsec", (("run_id", "r1"),), state="intended"))
    ledger.mark_acquired(Resource("container", "geometrikks-shots-crowdsec", (("run_id", "r1"),), state="intended"))
    assert [(r.ident, r.state) for r in ledger.owned()] == [("geometrikks-shots-crowdsec", "acquired")]
    assert [r.ident for r in ledger.load()] == ["geometrikks-shots-old", "geometrikks-shots-crowdsec"]
    ledger.discard(Resource("container", "geometrikks-shots-crowdsec"))
    assert ledger.owned() == []
    assert [r.ident for r in ledger.load()] == ["geometrikks-shots-old"]


def test_discard_removes_this_instance_entry_not_a_stale_twin(tmp_path: Path) -> None:
    stale = Resource("process", "101", (("label", "app"), ("start_time", "1")))
    Ledger(tmp_path / "ledger.json").add(stale)
    ledger = Ledger(tmp_path / "ledger.json")
    ledger.add(Resource("process", "101", (("label", "app"), ("start_time", "2"))))
    ledger.discard(Resource("process", "101"))
    assert ledger.load() == [stale]


def test_execute_keeps_going_and_reports_failures(tmp_path: Path) -> None:
    fake = FakeActions(
        start_times={101: "123"},
        labels={"geometrikks-shots-crowdsec": "r1"},
        errors={
            "remove_container geometrikks-shots-crowdsec": RuntimeError("boom"),
            "drop_database geometrikks_screenshots": RuntimeError('database "geometrikks_screenshots" does not exist'),
        },
    )
    resources = [
        Resource("process", "101", (("label", "app"), ("start_time", "123"))),
        Resource("container", "geometrikks-shots-crowdsec", (("run_id", "r1"),)),
        Resource("database", "geometrikks_screenshots", (("admin_url", "postgresql://x"),)),
    ]
    ledger = ledger_with(tmp_path / "ledger.json", resources)
    failures = execute_teardown(resources, run_root=tmp_path, ledger=ledger, actions=fake)
    assert failures == ["container geometrikks-shots-crowdsec: boom"]
    assert fake.calls == [
        "stop_process 101",
        "remove_container geometrikks-shots-crowdsec",
        "drop_database geometrikks_screenshots",
    ]
    assert [r.kind for r in ledger.load()] == ["container"]


def test_execute_skips_what_it_cannot_prove_it_owns(tmp_path: Path) -> None:
    fake = FakeActions(start_times={101: "999"}, labels={"geometrikks-shots-crowdsec": "other-run"})
    resources = [
        Resource("process", "101", (("label", "app"), ("start_time", "123"))),
        Resource("container", "geometrikks-shots-crowdsec", (("run_id", "r1"),)),
    ]
    ledger = ledger_with(tmp_path / "ledger.json", resources)
    report = execute_teardown(resources, run_root=tmp_path, ledger=ledger, actions=fake)
    assert report == [
        "process 101 (app): start time changed, not ours; skipped",
        "container geometrikks-shots-crowdsec: labelled other-run, not r1; skipped",
    ]
    assert fake.calls == []
    assert not ledger.exists()


def test_execute_treats_missing_leaders_and_labels_as_gone_or_orphaned(tmp_path: Path) -> None:
    fake = FakeActions(alive_groups={202})
    resources = [
        Resource("process", "101", (("label", "app"), ("start_time", "123"))),
        Resource("process", "202", (("label", "feeder"), ("start_time", "456"))),
        Resource("network", "geometrikks-shots-net", (("run_id", "r1"),)),
        Resource("directory", str(tmp_path / "run1")),
    ]
    ledger = ledger_with(tmp_path / "ledger.json", resources)
    fake.errors["remove_directory " + str(tmp_path / "run1")] = FileNotFoundError("[Errno 2] No such file or directory")
    assert execute_teardown(resources, run_root=tmp_path, ledger=ledger, actions=fake) == []
    assert fake.calls == ["stop_process 202", "remove_directory " + str(tmp_path / "run1")]
    assert not ledger.exists()


def test_execute_leaves_entries_it_was_not_given(tmp_path: Path) -> None:
    other = Resource("container", "geometrikks-shots-old", (("run_id", "r0"),))
    Ledger(tmp_path / "ledger.json").add(other)
    ledger = Ledger(tmp_path / "ledger.json")
    ledger.add(Resource("network", "geometrikks-shots-net", (("run_id", "r1"),)))
    fake = FakeActions(labels={"geometrikks-shots-net": "r1"})
    assert execute_teardown(ledger.owned(), run_root=tmp_path, ledger=ledger, actions=fake) == []
    assert fake.calls == ["remove_network geometrikks-shots-net"]
    assert ledger.load() == [other]


def test_own_db_database_goes_with_its_container(tmp_path: Path) -> None:
    db = Resource(
        "database",
        "geometrikks_screenshots",
        (("admin_url", "postgresql://x"), ("container", "geometrikks-shots-db")),
    )
    box = Resource("container", "geometrikks-shots-db", (("run_id", "r1"),))
    assert plan_teardown([db, box], run_root=tmp_path) == [box]
    ledger = ledger_with(tmp_path / "ledger.json", [db, box])
    fake = FakeActions(labels={"geometrikks-shots-db": "r1"})
    assert execute_teardown([db, box], run_root=tmp_path, ledger=ledger, actions=fake) == []
    assert fake.calls == ["remove_container geometrikks-shots-db"]
    assert not ledger.exists()


def test_own_db_database_stays_while_its_container_does(tmp_path: Path) -> None:
    db = Resource(
        "database",
        "geometrikks_screenshots",
        (("admin_url", "postgresql://x"), ("container", "geometrikks-shots-db")),
    )
    box = Resource("container", "geometrikks-shots-db", (("run_id", "r1"),))
    ledger = ledger_with(tmp_path / "ledger.json", [db, box])
    fake = FakeActions(
        labels={"geometrikks-shots-db": "r1"},
        errors={"remove_container geometrikks-shots-db": RuntimeError("daemon down")},
    )
    assert execute_teardown([db, box], run_root=tmp_path, ledger=ledger, actions=fake) == [
        "container geometrikks-shots-db: daemon down"
    ]
    assert ledger.load() == [db, box]


@pytest.mark.parametrize(
    ("resource", "text", "gone"),
    [
        (Resource("container", "c"), "Error response from daemon: No such container: c", True),
        (Resource("network", "n"), "Error: No such network: n", True),
        (Resource("network", "n"), "network n not found", True),
        (Resource("database", "d"), 'database "d" does not exist', True),
        (Resource("process", "7"), str(ProcessLookupError(3, "No such process")), True),
        (Resource("directory", "/x"), "[Errno 2] No such file or directory: '/x'", True),
        (Resource("container", "c"), "Cannot connect to the Docker daemon", False),
        (Resource("database", "d"), "connection refused", False),
    ],
)
def test_already_gone(resource: Resource, text: str, gone: bool) -> None:
    assert already_gone(resource, text) is gone


def test_proc_start_time_reads_field_22_past_the_command_name(tmp_path: Path) -> None:
    odd = tmp_path / "a) b c"
    odd.symlink_to(sys.executable)
    child = start_child(
        [str(odd), "-c", "import time; time.sleep(30)"],
        env=CHILD_ENV,
        log_path=tmp_path / "child.log",
        label="odd",
        ledger=Ledger(tmp_path / "ledger.json"),
    )
    try:
        deadline = time.monotonic() + 5
        while ") b c" not in Path(f"/proc/{child.pid}/stat").read_text() and time.monotonic() < deadline:
            time.sleep(0.02)
        expected = Path(f"/proc/{child.pid}/stat").read_text().replace("(a) b c)", "comm").split()[21]
        assert proc_start_time(child.pid) == expected
        assert expected.isdigit()
    finally:
        stop_child(child, ledger=Ledger(tmp_path / "ledger.json"))
    pid_max = int(Path("/proc/sys/kernel/pid_max").read_text())
    assert proc_start_time(pid_max + 1) is None


def test_ensure_run_root_creates_a_private_directory(tmp_path: Path) -> None:
    root = ensure_run_root(tmp_path / "run")
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    (tmp_path / "loose").mkdir(mode=0o755)
    assert stat.S_IMODE(ensure_run_root(tmp_path / "loose").stat().st_mode) == 0o700
    (tmp_path / "link").symlink_to(tmp_path / "run")
    with pytest.raises(RuntimeError, match="symlink"):
        ensure_run_root(tmp_path / "link")


def test_run_lock_is_exclusive(tmp_path: Path) -> None:
    fd = acquire_run_lock(tmp_path / "run.lock")
    with pytest.raises(RunLocked, match="run.lock"):
        acquire_run_lock(tmp_path / "run.lock")
    os.close(fd)
    os.close(acquire_run_lock(tmp_path / "run.lock"))
    assert stat.S_IMODE((tmp_path / "run.lock").stat().st_mode) == 0o600


def test_interrupts_raise_maps_sigterm() -> None:
    before = signal.getsignal(signal.SIGTERM)
    with pytest.raises(Interrupted), interrupts_raise():
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(1)
    assert signal.getsignal(signal.SIGTERM) is before


def test_interrupted_is_not_an_exception() -> None:
    assert not issubclass(Interrupted, Exception)


def test_interrupts_deferred_raises_after_the_block() -> None:
    finished = []
    with pytest.raises(Interrupted), interrupts_raise(), interrupts_deferred():
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(0.2)
        finished.append(True)
    assert finished == [True]


def test_interrupts_deferred_alone_changes_nothing() -> None:
    before = signal.getsignal(signal.SIGTERM)
    with interrupts_deferred():
        assert signal.getsignal(signal.SIGTERM) is before
    with interrupts_ignored(), interrupts_deferred():
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(0.2)
    assert signal.getsignal(signal.SIGTERM) is before


def test_children_never_inherit_ignored_signals(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "ledger.json")
    probe = (
        "import signal; print(all(signal.getsignal(s) is not signal.SIG_IGN "
        "for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)))"
    )
    with interrupts_ignored():
        code = run_child(
            [sys.executable, "-c", probe],
            env=CHILD_ENV,
            log_path=tmp_path / "child.log",
            label="probe",
            ledger=ledger,
        )
    assert code == 0
    assert (tmp_path / "child.log").read_text().split() == ["True"]


def test_run_child_gets_its_own_group_and_the_repo_root(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "ledger.json")
    code = run_child(
        [sys.executable, "-c", "import os; print(os.getpgid(0) == os.getpid(), os.getcwd())"],
        env=CHILD_ENV,
        log_path=tmp_path / "child.log",
        label="probe",
        ledger=ledger,
    )
    assert code == 0
    assert (tmp_path / "child.log").read_text().split() == ["True", str(REPO_ROOT)]
    assert ledger.load() == []


def test_run_child_splits_stdout_from_the_log(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "ledger.json")
    code = run_child(
        [sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr); sys.exit(3)"],
        env=CHILD_ENV,
        log_path=tmp_path / "child.log",
        label="probe",
        ledger=ledger,
        stdout_path=tmp_path / "child.out",
    )
    assert code == 3
    assert (tmp_path / "child.out").read_text() == "out\n"
    assert (tmp_path / "child.log").read_text() == "err\n"


def test_a_running_child_is_in_the_ledger_with_its_start_time(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "ledger.json")
    child = start_child(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        env=CHILD_ENV,
        log_path=tmp_path / "child.log",
        label="sleeper",
        ledger=ledger,
    )
    try:
        [entry] = ledger.load()
        assert entry.ident == str(child.pid)
        assert dict(entry.meta) == {"label": "sleeper", "start_time": proc_start_time(child.pid)}
    finally:
        stop_child(child, ledger=ledger)
    assert ledger.load() == []
    assert child.poll() is not None


def group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    return True


SPAWN_GRANDCHILD = (
    "import subprocess, sys, time; "
    "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
    "time.sleep(float(sys.argv[1]))"
)


def test_stop_child_stops_the_whole_group(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "ledger.json")
    child = start_child(
        [sys.executable, "-c", SPAWN_GRANDCHILD, "30"],
        env=CHILD_ENV,
        log_path=tmp_path / "child.log",
        label="parent",
        ledger=ledger,
    )
    time.sleep(0.5)
    stop_child(child, ledger=ledger)
    assert not group_alive(child.pid)


def test_wait_child_kills_what_the_leader_left_behind(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "ledger.json")
    child = start_child(
        [sys.executable, "-c", SPAWN_GRANDCHILD, "0.3"],
        env=CHILD_ENV,
        log_path=tmp_path / "child.log",
        label="parent",
        ledger=ledger,
    )
    assert wait_child(child, ledger=ledger) == 0
    deadline = time.monotonic() + 5
    while group_alive(child.pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not group_alive(child.pid)
    assert ledger.load() == []


def test_wait_child_times_out_and_stops_the_child(tmp_path: Path) -> None:
    ledger = Ledger(tmp_path / "ledger.json")
    child = start_child(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        env=CHILD_ENV,
        log_path=tmp_path / "child.log",
        label="sleeper",
        ledger=ledger,
    )
    with pytest.raises(TimeoutError):
        wait_child(child, ledger=ledger, timeout=0.3)
    assert child.poll() is not None
    assert ledger.load() == []


FAKE_DOCKER = """#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
case "$*" in
  "container inspect --format {{json .Config.Labels}} geometrikks-shots-crowdsec")
    echo '{"geometrikks.screenshots.run":"r1","other":"x"}' ;;
  "container inspect --format {{json .Config.Labels}} geometrikks-shots-bare")
    echo 'null' ;;
  "network inspect --format {{json .Labels}} geometrikks-shots-net")
    echo '{"geometrikks.screenshots.run":"r2"}' ;;
  *"inspect"*"geometrikks-shots-missing")
    echo 'Error: No such object: geometrikks-shots-missing' >&2; exit 1 ;;
  *"inspect"*"geometrikks-shots-broken")
    echo 'Cannot connect to the Docker daemon' >&2; exit 1 ;;
  "rm -f -v geometrikks-shots-broken")
    echo 'Cannot connect to the Docker daemon' >&2; exit 1 ;;
esac
"""


@pytest.fixture
def system_actions(tmp_path: Path) -> tuple[SystemActions, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    calls = tmp_path / "docker-calls.txt"
    env = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "DOCKER_CALLS": str(calls)}
    (tmp_path / "logs").mkdir()
    actions = SystemActions(ledger=Ledger(tmp_path / "ledger.json"), env=env, log_dir=tmp_path / "logs")
    return actions, calls


def test_system_actions_read_the_run_label(system_actions: tuple[SystemActions, Path]) -> None:
    actions, _ = system_actions
    assert actions.run_label("container", "geometrikks-shots-crowdsec") == "r1"
    assert actions.run_label("container", "geometrikks-shots-bare") == ""
    assert actions.run_label("network", "geometrikks-shots-net") == "r2"
    assert actions.run_label("container", "geometrikks-shots-missing") is None
    with pytest.raises(RuntimeError, match="Docker daemon"):
        actions.run_label("network", "geometrikks-shots-broken")


def test_system_actions_remove_containers_with_their_volumes(system_actions: tuple[SystemActions, Path]) -> None:
    actions, calls = system_actions
    actions.remove_container("geometrikks-shots-crowdsec")
    actions.remove_network("geometrikks-shots-net")
    assert calls.read_text().splitlines() == [
        "rm -f -v geometrikks-shots-crowdsec",
        "network rm geometrikks-shots-net",
    ]
    with pytest.raises(RuntimeError, match="Docker daemon"):
        actions.remove_container("geometrikks-shots-broken")


def test_system_actions_stop_a_process_group(tmp_path: Path, system_actions: tuple[SystemActions, Path]) -> None:
    actions, _ = system_actions
    ledger = Ledger(tmp_path / "child-ledger.json")
    child = start_child(
        [sys.executable, "-c", SPAWN_GRANDCHILD, "30"],
        env=CHILD_ENV,
        log_path=tmp_path / "child.log",
        label="parent",
        ledger=ledger,
    )
    time.sleep(0.5)
    assert actions.group_alive(child.pid)
    assert actions.process_start_time(child.pid) == dict(ledger.load()[0].meta)["start_time"]
    actions.stop_process(child.pid)
    assert not actions.group_alive(child.pid)


def test_system_actions_refuse_other_databases_and_symlinks(
    tmp_path: Path, system_actions: tuple[SystemActions, Path]
) -> None:
    actions, _ = system_actions
    with pytest.raises(ValueError, match="geometrikks"):
        actions.drop_database("geometrikks", "postgresql://x")
    target = tmp_path / "keep"
    target.mkdir()
    (tmp_path / "run1").symlink_to(target)
    with pytest.raises(OSError):
        actions.remove_directory(tmp_path / "run1")
    assert target.exists()
    (tmp_path / "run2" / "logs").mkdir(parents=True)
    actions.remove_directory(tmp_path / "run2")
    assert not (tmp_path / "run2").exists()
