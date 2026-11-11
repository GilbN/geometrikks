"""Run root, lock, resource ledger, child processes, signal handling and teardown for the screenshot run."""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Generator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from types import FrameType
from typing import ClassVar, Literal, Protocol, get_args

RUN_ROOT: Path = Path(f"/tmp/geometrikks-screenshots-{os.getuid()}")
LEDGER_PATH = RUN_ROOT / "ledger.json"
LOCK_PATH = RUN_ROOT / "run.lock"
REPO_ROOT = Path(__file__).resolve().parents[2]
RESERVED_DATABASE = "geometrikks_screenshots"
NAME_PREFIX = "geometrikks-shots-"
RUN_LABEL = "geometrikks.screenshots.run"
TOKEN_ENV = "GEOMETRIKKS_SHOTS_TOKEN"

ResourceKind = Literal["process", "container", "network", "database", "directory"]
ResourceState = Literal["intended", "acquired"]

_KIND_ORDER: tuple[ResourceKind, ...] = ("process", "container", "network", "database", "directory")
_STATES: tuple[ResourceState, ...] = get_args(ResourceState)
_STOP_GRACE_SECONDS = 10.0
_DOCKER_TIMEOUT_SECONDS = 60.0


def ensure_run_root(path: Path = RUN_ROOT) -> Path:
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        raise RuntimeError(f"{path} is a symlink; refusing to use it as the run root")
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"{path} is not a directory; refusing to use it as the run root")
    if info.st_uid != os.getuid():
        raise RuntimeError(f"{path} is owned by uid {info.st_uid}, not {os.getuid()}; refusing to use it")
    os.chmod(path, 0o700)
    return path


class RunLocked(RuntimeError):
    pass


def acquire_run_lock(path: Path = LOCK_PATH) -> int:
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise RunLocked(f"another screenshot run holds {path}") from None
    return fd


@dataclass(frozen=True, slots=True)
class Resource:
    kind: ResourceKind
    ident: str
    meta: tuple[tuple[str, str], ...] = ()
    state: ResourceState = "acquired"

    def meta_value(self, key: str) -> str | None:
        return dict(self.meta).get(key)


def _same(entry: Resource, probe: Resource) -> bool:
    """Match on kind and ident, and on meta too when the probe carries any."""
    return entry.kind == probe.kind and entry.ident == probe.ident and (not probe.meta or entry.meta == probe.meta)


def _first_index(entries: Sequence[Resource], probe: Resource) -> int | None:
    return next((index for index, entry in enumerate(entries) if _same(entry, probe)), None)


def _resource_from_json(raw: object) -> Resource:
    if not isinstance(raw, dict):
        raise TypeError(f"ledger entry is not an object: {raw!r}")
    kind, ident, meta, state = raw.get("kind"), raw.get("ident"), raw.get("meta", []), raw.get("state", "acquired")
    if kind not in _KIND_ORDER:
        raise ValueError(f"ledger entry has an unknown kind: {kind!r}")
    if state not in _STATES:
        raise ValueError(f"ledger entry has an unknown state: {state!r}")
    if not isinstance(ident, str) or not ident:
        raise ValueError(f"ledger entry has no ident: {raw!r}")
    if not isinstance(meta, list) or not all(
        isinstance(pair, list) and len(pair) == 2 and all(isinstance(part, str) for part in pair) for pair in meta
    ):
        raise ValueError(f"ledger entry has malformed meta: {raw!r}")
    return Resource(kind, ident, tuple((key, value) for key, value in meta), state)


class Ledger:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._owned: list[Resource] = []

    def exists(self) -> bool:
        return self.path.exists()

    def load(self) -> list[Resource]:
        try:
            raw = json.loads(self.path.read_text())
        except FileNotFoundError:
            return []
        if not isinstance(raw, list):
            raise TypeError(f"{self.path} does not hold a list")
        return [_resource_from_json(entry) for entry in raw]

    def owned(self) -> list[Resource]:
        return list(self._owned)

    def add(self, resource: Resource) -> None:
        with interrupts_deferred():
            entries = self.load()
            entries.append(resource)
            self._write(entries)
            self._owned.append(resource)

    def mark_acquired(self, resource: Resource) -> Resource:
        with interrupts_deferred():
            index = _first_index(self._owned, resource)
            target = self._owned[index] if index is not None else resource
            acquired = replace(target, state="acquired")
            entries = self.load()
            file_index = _first_index(entries, target)
            if file_index is None:
                entries.append(acquired)
            else:
                entries[file_index] = acquired
            self._write(entries)
            if index is None:
                self._owned.append(acquired)
            else:
                self._owned[index] = acquired
            return acquired

    def discard(self, resource: Resource) -> None:
        with interrupts_deferred():
            index = _first_index(self._owned, resource)
            target = self._owned[index] if index is not None else resource
            entries = self.load()
            file_index = _first_index(entries, target)
            if file_index is not None:
                del entries[file_index]
                self._write(entries)
            if index is not None:
                del self._owned[index]

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)
        self._owned.clear()

    def _write(self, entries: Sequence[Resource]) -> None:
        payload = [
            {"kind": entry.kind, "ident": entry.ident, "meta": [list(pair) for pair in entry.meta], "state": entry.state}
            for entry in entries
        ]
        fd, temp_name = tempfile.mkstemp(dir=self.path.parent, prefix=f".{self.path.name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(payload, handle, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp_name, 0o600)
            os.replace(temp_name, self.path)
        except BaseException:
            Path(temp_name).unlink(missing_ok=True)
            raise


def _check_owned_name(resource: Resource, run_root: Path) -> None:
    if resource.kind == "process":
        if not resource.ident.isdigit() or int(resource.ident) <= 1 or int(resource.ident) == os.getpgrp():
            raise ValueError(f"refusing to signal process group {resource.ident!r}")
    elif resource.kind in ("container", "network"):
        if not resource.ident.startswith(NAME_PREFIX):
            raise ValueError(f"refusing to remove {resource.kind} {resource.ident!r}: not a {NAME_PREFIX}* name")
        if not resource.meta_value("run_id"):
            raise ValueError(f"refusing to remove {resource.kind} {resource.ident!r}: no run_id recorded")
    elif resource.kind == "database":
        if resource.ident != RESERVED_DATABASE:
            raise ValueError(f"refusing to drop database {resource.ident!r}: only {RESERVED_DATABASE} is ours")
        if not resource.meta_value("admin_url"):
            raise ValueError(f"refusing to drop database {resource.ident!r}: no admin_url recorded")
    else:
        path = Path(resource.ident)
        root = Path(os.path.normpath(run_root))
        normal = Path(os.path.normpath(path))
        if not path.is_absolute() or root not in normal.parents:
            raise ValueError(f"refusing to remove directory {resource.ident!r}: not inside {run_root}")


def _rides_with_container(resource: Resource) -> bool:
    return resource.kind == "database" and bool(resource.meta_value("container"))


def plan_teardown(resources: Sequence[Resource], *, run_root: Path) -> list[Resource]:
    for resource in resources:
        _check_owned_name(resource, run_root)
    ranked = [
        (_KIND_ORDER.index(resource.kind), -position, resource)
        for position, resource in enumerate(resources)
        if not _rides_with_container(resource)
    ]
    return [resource for _, _, resource in sorted(ranked, key=lambda rank: rank[:2])]


def _gone_markers(resource: Resource) -> tuple[str, ...]:
    if resource.kind == "container":
        return ("No such container",)
    if resource.kind == "network":
        return ("No such network", f"network {resource.ident} not found")
    if resource.kind == "database":
        return (f'database "{RESERVED_DATABASE}" does not exist',)
    if resource.kind == "process":
        return ("ProcessLookupError", "No such process")
    return ("No such file",)


def already_gone(resource: Resource, error_text: str) -> bool:
    return any(marker in error_text for marker in _gone_markers(resource))


def proc_start_time(pid: int) -> str | None:
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
    except (FileNotFoundError, ProcessLookupError):
        return None
    # Field 2 is the command name in parentheses and may itself hold spaces or ")".
    after_name = text.rsplit(")", 1)[1].split()
    return after_name[22 - 3]


class TeardownActions(Protocol):
    def process_start_time(self, pid: int) -> str | None: ...

    def group_alive(self, pgid: int) -> bool: ...

    def group_has_token(self, pgid: int, token: str) -> bool: ...

    def stop_process(self, pgid: int, *, start_time: str = "", token: str = "") -> None: ...

    def run_label(self, kind: Literal["container", "network"], name: str) -> str | None: ...

    def remove_container(self, name: str) -> None: ...

    def remove_network(self, name: str) -> None: ...

    def drop_database(self, name: str, admin_url: str) -> None: ...

    def remove_directory(self, path: Path) -> None: ...


def _describe(resource: Resource) -> str:
    label = resource.meta_value("label")
    if resource.kind == "process" and label:
        return f"process {resource.ident} ({label})"
    return f"{resource.kind} {resource.ident}"


def _tear_down_one(resource: Resource, actions: TeardownActions) -> str | None:
    """Act on one resource; return a skip line, or None once it is gone."""
    if resource.kind == "process":
        pgid = int(resource.ident)
        leader_start = actions.process_start_time(pgid)
        if leader_start is None:
            if not actions.group_alive(pgid):
                return None
            # The leader's pid is free again, so a live group under this pgid may be a stranger's.
            if not actions.group_has_token(pgid, resource.meta_value("token") or ""):
                label = resource.meta_value("label")
                named = f"process group {pgid} ({label})" if label else f"process group {pgid}"
                return f"{named}: leader gone and no live member carries its token; skipped"
            actions.stop_process(pgid, token=resource.meta_value("token") or "")
            return None
        if leader_start != resource.meta_value("start_time"):
            return f"{_describe(resource)}: start time changed, not ours; skipped"
        actions.stop_process(
            pgid, start_time=resource.meta_value("start_time") or "", token=resource.meta_value("token") or ""
        )
        return None
    if resource.kind in ("container", "network"):
        kind: Literal["container", "network"] = "container" if resource.kind == "container" else "network"
        expected = resource.meta_value("run_id")
        label = actions.run_label(kind, resource.ident)
        if label is None:
            return None
        if label != expected:
            return f"{_describe(resource)}: labelled {label or '(nothing)'}, not {expected}; skipped"
        if kind == "container":
            actions.remove_container(resource.ident)
        else:
            actions.remove_network(resource.ident)
        return None
    if resource.kind == "database":
        actions.drop_database(resource.ident, resource.meta_value("admin_url") or "")
        return None
    actions.remove_directory(Path(resource.ident))
    return None


def execute_teardown(
    resources: Sequence[Resource], *, run_root: Path, ledger: Ledger, actions: TeardownActions
) -> list[str]:
    report: list[str] = []
    accepted: list[Resource] = []
    for resource in resources:
        try:
            _check_owned_name(resource, run_root)
        except ValueError as refusal:
            report.append(str(refusal))
            continue
        accepted.append(resource)
    plan = plan_teardown(accepted, run_root=run_root)
    planned = set(map(id, plan))
    riders = [resource for resource in accepted if id(resource) not in planned]
    released_containers: set[str] = set()
    for resource in plan:
        try:
            skipped = _tear_down_one(resource, actions)
        except Exception as error:  # noqa: BLE001
            # Docker calls already sort "gone" from a failed call by exit code; their errors are real failures.
            if resource.kind in ("container", "network") or not already_gone(
                resource, f"{type(error).__name__}: {error}"
            ):
                report.append(f"{_describe(resource)}: {error}")
                continue
            skipped = None
        if skipped is not None:
            report.append(skipped)
        ledger.discard(resource)
        if resource.kind == "container":
            released_containers.add(resource.ident)
    # A database inside a container we removed, found gone, do not own, or no longer track is not ours to drop.
    tracked = {entry.ident for entry in [*ledger.load(), *resources] if entry.kind == "container"}
    for resource in riders:
        container = resource.meta_value("container")
        if container in released_containers or container not in tracked:
            ledger.discard(resource)
    if ledger.exists() and not ledger.load():
        ledger.clear()
    return report


class Interrupted(BaseException):
    def __init__(self, signum: int) -> None:
        super().__init__(f"interrupted by {signal.Signals(signum).name}")
        self.signum = signum


_INTERRUPT_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)


class _Deferral:
    depth: ClassVar[int] = 0
    held: ClassVar[list[int]] = []


def _raise_interrupted(signum: int, frame: FrameType | None) -> None:
    if _Deferral.depth:
        _Deferral.held.append(signum)
        return
    raise Interrupted(signum)


@contextmanager
def _handlers(handler: Callable[[int, FrameType | None], None] | signal.Handlers) -> Generator[None]:
    previous = {signum: signal.getsignal(signum) for signum in _INTERRUPT_SIGNALS}
    for signum in _INTERRUPT_SIGNALS:
        signal.signal(signum, handler)
    try:
        yield
    finally:
        for signum, old in previous.items():
            signal.signal(signum, signal.SIG_DFL if old is None else old)


@contextmanager
def interrupts_raise() -> Generator[None]:
    with _handlers(_raise_interrupted):
        yield


@contextmanager
def interrupts_ignored() -> Generator[None]:
    with _handlers(signal.SIG_IGN):
        yield


@contextmanager
def interrupts_deferred() -> Generator[None]:
    if not all(signal.getsignal(signum) is _raise_interrupted for signum in _INTERRUPT_SIGNALS):
        yield
        return
    _Deferral.depth += 1
    try:
        yield
    finally:
        _Deferral.depth -= 1
        if not _Deferral.depth and _Deferral.held:
            signum = _Deferral.held[0]
            _Deferral.held.clear()
            raise Interrupted(signum)


# A child started under interrupts_ignored() inherits SIG_IGN for these, and Popen's
# restore_signals only covers SIGPIPE, SIGXFZ and SIGXFSZ. preexec_fn is unsafe with threads.
# The wrapper then holds on argv[1], a pipe from the parent, and execs only once the parent has
# recorded it in the ledger; EOF first means the parent died, so nothing would ever stop the child.
CHILD_WRAPPER: tuple[str, ...] = (
    sys.executable,
    "-I",
    "-c",
    (
        "import os, signal, sys\n"
        "for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):\n"
        "    signal.signal(signum, signal.SIG_DFL)\n"
        "go_fd = int(sys.argv[1])\n"
        "if os.read(go_fd, 1) != b'1':\n"
        "    os._exit(70)\n"
        "os.close(go_fd)\n"
        "os.execvp(sys.argv[2], sys.argv[2:])\n"
    ),
)


def spawn_unregistered(
    argv: Sequence[str], *, env: Mapping[str, str], log_path: Path, stdout_path: Path | None
) -> tuple[subprocess.Popen[bytes], int]:
    """Start the wrapper held before exec; write b"1" to the returned fd to release it, close it to cancel."""
    read_fd, go_fd = os.pipe()
    try:
        with log_path.open("ab") as log, (stdout_path.open("wb") if stdout_path else log_path.open("ab")) as out:
            child = subprocess.Popen(
                [*CHILD_WRAPPER, str(read_fd), *argv],
                cwd=REPO_ROOT,
                env=dict(env),
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=log,
                start_new_session=True,
                pass_fds=(read_fd,),
            )
    except BaseException:
        os.close(go_fd)
        raise
    finally:
        os.close(read_fd)
    return child, go_fd


def start_child(
    argv: Sequence[str],
    *,
    env: Mapping[str, str],
    log_path: Path,
    label: str,
    ledger: Ledger,
    stdout_path: Path | None = None,
) -> subprocess.Popen[bytes]:
    token = secrets.token_hex(16)
    with interrupts_deferred():
        child, go_fd = spawn_unregistered(
            argv, env={**env, TOKEN_ENV: token}, log_path=log_path, stdout_path=stdout_path
        )
        try:
            start_time = proc_start_time(child.pid) or ""
            ledger.add(
                Resource("process", str(child.pid), (("label", label), ("start_time", start_time), ("token", token)))
            )
        except BaseException:
            os.close(go_fd)
            child.wait()
            raise
        try:
            os.write(go_fd, b"1")
        except BrokenPipeError:
            pass
        finally:
            os.close(go_fd)
    return child


def _signal_group(pgid: int, signum: int) -> None:
    try:
        os.killpg(pgid, signum)
    except ProcessLookupError:
        pass


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _group_members(pgid: int) -> list[int]:
    members = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            text = (entry / "stat").read_text()
        except OSError:
            continue
        if text.rsplit(")", 1)[1].split()[2] == str(pgid):
            members.append(int(entry.name))
    return members


def _group_has_token(pgid: int, token: str) -> bool:
    if not token:
        return False
    wanted = f"{TOKEN_ENV}={token}".encode()
    for pid in _group_members(pgid):
        try:
            environ = Path(f"/proc/{pid}/environ").read_bytes()
        except OSError:
            continue
        if wanted in environ.split(b"\0"):
            return True
    return False


def _child_exited(pid: int) -> bool | None:
    """Whether our child pid has exited, leaving it unreaped; None when it is not an unreaped child of ours."""
    try:
        return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    except ChildProcessError:
        return None


def _await_exit(pid: int, timeout: float | None) -> bool:
    """Wait for our child to exit without reaping it, so its pid keeps pinning the process group."""
    if timeout is None:
        os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
        return True
    deadline = time.monotonic() + timeout
    delay = 0.0005
    while not _child_exited(pid):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        delay = min(delay * 2, remaining, 0.05)
        time.sleep(delay)
    return True


def _reap(pgid: int, leader: subprocess.Popen[bytes] | None) -> None:
    if leader is not None:
        leader.wait()
        return
    try:
        os.waitpid(pgid, 0)
    except ChildProcessError:
        pass


def _group_gone(pgid: int, *, own: bool) -> bool:
    if own:
        return bool(_child_exited(pgid)) and set(_group_members(pgid)) <= {pgid}
    return not _group_alive(pgid)


def _stop_group(
    pgid: int, leader: subprocess.Popen[bytes] | None, *, still_ours: Callable[[], bool] | None = None
) -> None:
    # Our unreaped leader pins the pgid, even as a zombie, so it is reaped only after the last signal.
    # Any other group can empty and have its pgid reused between signals, so ownership is checked before each one.
    own = _child_exited(pgid) is not None
    if not own and still_ours is not None and not still_ours():
        return
    _signal_group(pgid, signal.SIGTERM)
    deadline = time.monotonic() + _STOP_GRACE_SECONDS
    while time.monotonic() < deadline:
        if _group_gone(pgid, own=own):
            break
        time.sleep(0.05)
    else:
        if own or still_ours is None or still_ours():
            _signal_group(pgid, signal.SIGKILL)
    if own:
        _reap(pgid, leader)


def stop_child(child: subprocess.Popen[bytes], *, ledger: Ledger) -> None:
    _stop_group(child.pid, child)
    ledger.discard(Resource("process", str(child.pid)))


def wait_child(child: subprocess.Popen[bytes], *, ledger: Ledger, timeout: float | None = None) -> int:
    if child.returncode is None:
        if not _await_exit(child.pid, timeout):
            stop_child(child, ledger=ledger)
            raise TimeoutError(f"process {child.pid} did not finish within {timeout} s")
        _signal_group(child.pid, signal.SIGKILL)
    code = child.wait()
    ledger.discard(Resource("process", str(child.pid)))
    return code


def run_child(
    argv: Sequence[str],
    *,
    env: Mapping[str, str],
    log_path: Path,
    label: str,
    ledger: Ledger,
    stdout_path: Path | None = None,
    timeout: float | None = None,
) -> int:
    child = start_child(argv, env=env, log_path=log_path, label=label, ledger=ledger, stdout_path=stdout_path)
    return wait_child(child, ledger=ledger, timeout=timeout)


class SystemActions:
    """The real teardown actions; every docker call goes through run_child."""

    def __init__(self, *, ledger: Ledger, env: Mapping[str, str], log_dir: Path) -> None:
        self._ledger = ledger
        self._env = dict(env)
        docker = shutil.which("docker", path=self._env.get("PATH", ""))
        if docker is None:
            raise RuntimeError(f"docker is not on the run's PATH ({self._env.get('PATH', '')!r})")
        self._docker_path = docker
        self._log_path = log_dir / "teardown.log"
        self._stdout_path = log_dir / "teardown-docker.out"

    def _docker(self, *args: str) -> tuple[int, str, str]:
        offset = self._log_path.stat().st_size if self._log_path.exists() else 0
        code = run_child(
            [self._docker_path, *args],
            env=self._env,
            log_path=self._log_path,
            label=f"docker {args[0]}",
            ledger=self._ledger,
            stdout_path=self._stdout_path,
            timeout=_DOCKER_TIMEOUT_SECONDS,
        )
        with self._log_path.open("rb") as log:
            log.seek(offset)
            errors = log.read().decode(errors="replace").strip()
        return code, self._stdout_path.read_text().strip(), errors

    def process_start_time(self, pid: int) -> str | None:
        return proc_start_time(pid)

    def group_alive(self, pgid: int) -> bool:
        return _group_alive(pgid)

    def group_has_token(self, pgid: int, token: str) -> bool:
        return _group_has_token(pgid, token)

    def stop_process(self, pgid: int, *, start_time: str = "", token: str = "") -> None:
        def still_ours() -> bool:
            if start_time and proc_start_time(pgid) == start_time:
                return True
            return _group_has_token(pgid, token)

        _stop_group(pgid, None, still_ours=still_ours)

    def run_label(self, kind: Literal["container", "network"], name: str) -> str | None:
        labels_path = "{{json .Config.Labels}}" if kind == "container" else "{{json .Labels}}"
        code, out, errors = self._docker(kind, "inspect", "--format", labels_path, name)
        if code == 1 and already_gone(Resource(kind, name), errors):
            return None
        if code != 0:
            raise RuntimeError(f"docker {kind} inspect {name} exited {code}: {errors}")
        labels = json.loads(out) or {}
        return str(labels.get(RUN_LABEL, ""))

    def remove_container(self, name: str) -> None:
        # -v: the CrowdSec container carries an anonymous volume for /var/lib/crowdsec/data.
        code, _, errors = self._docker("rm", "-f", "-v", name)
        if code == 1 and already_gone(Resource("container", name), errors):
            return
        if code != 0:
            raise RuntimeError(errors or f"docker rm {name} exited {code}")

    def remove_network(self, name: str) -> None:
        code, _, errors = self._docker("network", "rm", name)
        if code == 1 and already_gone(Resource("network", name), errors):
            return
        if code != 0:
            raise RuntimeError(errors or f"docker network rm {name} exited {code}")

    def drop_database(self, name: str, admin_url: str) -> None:
        if name != RESERVED_DATABASE:
            raise ValueError(f"refusing to drop database {name!r}: only {RESERVED_DATABASE} is ours")
        asyncio.run(_drop_database(name, admin_url))

    def remove_directory(self, path: Path) -> None:
        shutil.rmtree(path)


async def _drop_database(name: str, admin_url: str) -> None:
    from sqlalchemy import make_url, text
    from sqlalchemy.ext.asyncio import create_async_engine

    url = make_url(admin_url).set(drivername="postgresql+asyncpg")
    engine = create_async_engine(url, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as connection:
            await connection.execute(text(f"DROP DATABASE {name} WITH (FORCE)"))
    finally:
        await engine.dispose()
