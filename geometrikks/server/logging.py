"""Structlog logging pipeline building blocks.

Sinks (wired in create_logging_config, Task 6): colored console, JSONL main
file, plain-text login file (CrowdSec/fail2ban contract), and a WebSocket
fan-out. All sit behind the stdlib queue listener so file IO and gzip never
block the event loop.
"""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import ipaddress
import json
import logging
import os
import shutil
import sys
import weakref
from logging.handlers import QueueHandler, RotatingFileHandler
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

import structlog
from litestar.logging.config import LoggingConfig, StructLoggingConfig

if TYPE_CHECKING:
    from geometrikks.config.settings import Settings

SUCCESS_LEVEL = 25  # between INFO (20) and WARNING (30)
LOGIN_LOGGER_NAME = "geometrikks.auth.login"

get_logger = structlog.stdlib.get_logger


def _stdlib_success(self: logging.Logger, message: str, *args: Any, **kwargs: Any) -> None:
    if self.isEnabledFor(SUCCESS_LEVEL):
        self._log(SUCCESS_LEVEL, message, args, **kwargs)


def register_success_level() -> None:
    """Register the SUCCESS level on stdlib logging. Idempotent."""
    if logging.getLevelName(SUCCESS_LEVEL) != "SUCCESS":
        logging.addLevelName(SUCCESS_LEVEL, "SUCCESS")
    if not hasattr(logging.Logger, "success"):
        logging.Logger.success = _stdlib_success  # ty: ignore[unresolved-attribute]


class SuccessBoundLogger(structlog.stdlib.BoundLogger):
    """Stdlib bound logger with a success() method (level 25)."""

    def success(self, event: str | None = None, *args: Any, **kw: Any) -> Any:
        return self._proxy_to_logger("success", event, *args, **kw)


def _gzip_rotator(source: str, dest: str) -> None:
    with open(source, "rb") as sf, gzip.open(dest, "wb") as df:
        shutil.copyfileobj(sf, df)
    os.remove(source)


def _gz_namer(default_name: str) -> str:
    return default_name + ".gz"


class GzipRotatingFileHandler(RotatingFileHandler):
    """Size-based rotation that gzips archives: app.log.1.gz ... app.log.N.gz."""

    _instances: ClassVar[weakref.WeakSet[GzipRotatingFileHandler]] = weakref.WeakSet()

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.namer = _gz_namer
        self.rotator = _gzip_rotator
        self.__class__._instances.add(self)


def rotate_log_files() -> list[str]:
    """Force a rollover of every live log file handler.

    Skips closed handlers (reconfiguration can leave stale, closed
    instances reachable via the weak-reference registry) and dedupes by
    baseFilename, keeping the first live handler found for each file. A
    handler whose current file is empty or missing is skipped too, since
    rotating an empty file would just churn archives.

    Returns the rotated base file names (e.g. ["geometrikks.log", "login.log"]).
    """
    rotated: list[str] = []
    seen: set[str] = set()
    for handler in list(GzipRotatingFileHandler._instances):
        if handler.stream is None:  # closed by a prior reconfiguration
            continue
        if handler.baseFilename in seen:
            continue
        seen.add(handler.baseFilename)
        handler.acquire()
        try:
            # Size check under the handler lock, so a concurrent rotation
            # (double-submitted request, or the handler's own size-triggered
            # rollover) cannot slip in between the check and the rollover
            # and leave us rotating a freshly emptied file.
            try:
                size = os.path.getsize(handler.baseFilename)
            except OSError:
                continue
            if size == 0:
                continue
            handler.doRollover()
        finally:
            handler.release()
        rotated.append(Path(handler.baseFilename).name)
    if rotated:
        get_logger(__name__).info("logs_rotated", files=rotated)
    return rotated


def _sanitize_login_field(value: str) -> str:
    """Strip control characters, quotes and backslashes so a hostile
    username cannot forge lines or fields in the login log."""
    cleaned = "".join(ch for ch in value if ch.isprintable())
    return cleaned.replace("\\", "").replace('"', "")


def render_login_line(_: Any, __: str, event_dict: dict[str, Any]) -> str:
    """Stable plain-text login line for CrowdSec/fail2ban parsers.

    Contract (do not change without a deprecation cycle):
    YYYY-MM-DDTHH:MM:SSZ <event> user="<user>" ip=<ip>
    """
    ts = str(event_dict.get("timestamp", ""))[:19] + "Z"
    raw_event = str(event_dict.get("event", ""))
    event = "".join(ch for ch in raw_event if ch.isalnum() or ch == "_") or "unknown"
    user = _sanitize_login_field(str(event_dict.get("user", "")))
    raw_ip = str(event_dict.get("ip") or "")
    try:
        ip = str(ipaddress.ip_address(raw_ip))
    except ValueError:
        ip = "-"
    return f'{ts} {event} user="{user}" ip={ip}'


class LoginOnlyFilter(logging.Filter):
    """Routes only geometrikks.auth.login records into the login file."""

    def filter(self, record: logging.LogRecord) -> bool:
        return record.name == LOGIN_LOGGER_NAME


class LogBroadcaster:
    """Fans rendered log event dicts out to in-process async subscribers.

    publish_threadsafe is called from the queue-listener thread; events hop
    onto the bound event loop via call_soon_threadsafe. Bounded queues drop
    the oldest event when a consumer is slow.
    """

    def __init__(self, max_queue: int = 1000) -> None:
        self._max_queue = max_queue
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._max_queue)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def publish_threadsafe(self, event: dict[str, Any]) -> None:
        loop = self._loop
        if loop is None or loop.is_closed() or not self._subscribers:
            return
        with contextlib.suppress(RuntimeError):  # loop shutting down
            loop.call_soon_threadsafe(self._publish, event)

    def _publish(self, event: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(event)


log_broadcaster = LogBroadcaster()


class BroadcastHandler(logging.Handler):
    """Publishes each record, rendered by its formatter, to the broadcaster."""

    def __init__(self, broadcaster: LogBroadcaster | None = None) -> None:
        super().__init__()
        self._broadcaster = broadcaster or log_broadcaster

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self._broadcaster.publish_threadsafe(json.loads(self.format(record)))
        except Exception:
            self.handleError(record)


MAIN_LOG_NAME = "geometrikks.log"
LOGIN_LOG_NAME = "login.log"


class NonBlockingQueueHandler(QueueHandler):
    """In-process ``QueueHandler`` that hands records to the queue unmodified.

    The stdlib default ``prepare()`` calls ``self.format()`` to flatten
    ``record.msg`` into a string so the record survives a pickled trip across
    a multiprocessing queue. We only ever use an in-process ``queue.Queue``
    (see queue_listener handler below), and structlog's
    ``wrap_for_formatter`` relies on ``record.msg`` staying the original
    event-dict (plus the ``_logger``/``_name`` attributes it attaches) all
    the way to ``ProcessorFormatter`` in the listener thread. Flattening it
    early turns every record into ``str(event_dict)`` and breaks every
    downstream sink, so this override is a no-op instead.
    """

    def prepare(self, record: logging.LogRecord) -> logging.LogRecord:
        return record


def _capture_exc_info(_: Any, __: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    """Resolve a lazy ``exc_info`` (``True`` or an exception instance) into a
    real ``(type, value, traceback)`` tuple, in place, before the record
    leaves this thread.

    structlog-native calls such as ``logger.exception(...)`` or
    ``logger.error(..., exc_info=True)`` (this is exactly what Litestar's
    default exception handler does) only stash ``exc_info=True`` in the
    event dict; turning that into an actual traceback is deferred to
    whichever processor runs ``structlog.processors.format_exc_info``. Our
    pipeline queues every record (``NonBlockingQueueHandler``) and only
    renders it later, on the ``LoggingQueueListener`` thread. ``exc_info``
    is thread-local, so by the time a deferred ``format_exc_info`` called
    ``sys.exc_info()`` there, the original ``except`` block (and thread)
    were long gone and it silently got ``(None, None, None)`` -- the
    traceback was lost forever and no "exception" key was ever produced.

    Running this as one of the shared processors (used both as the
    structlog-native processor chain and as ``foreign_pre_chain`` for
    stdlib records) captures the live traceback synchronously, in the
    original call-site thread, before the record is queued. Foreign stdlib
    records already carry a resolved tuple on ``record.exc_info`` by the
    time this runs, so this is a no-op for them.
    """
    exc_info = event_dict.get("exc_info")
    if exc_info is True:
        exc_info = sys.exc_info()
        event_dict["exc_info"] = exc_info
    elif isinstance(exc_info, BaseException):
        exc_info = (type(exc_info), exc_info, exc_info.__traceback__)
        event_dict["exc_info"] = exc_info
    # One-line summary next to the full traceback, e.g.
    # "NotAuthorizedException: 401: no session data found"; setdefault so an
    # explicit error=... kwarg (scheduler job failures) is never clobbered.
    if isinstance(exc_info, tuple) and len(exc_info) == 3 and exc_info[1] is not None:
        event_dict.setdefault("error", f"{type(exc_info[1]).__name__}: {exc_info[1]}")
    return event_dict


def _shared_processors() -> list[Any]:
    return [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.ExtraAdder(),
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        _capture_exc_info,
    ]


def _console_exception_formatter() -> Any:
    """Pretty, colorized traceback for the console, without dumping locals.

    structlog.dev.ConsoleRenderer defaults to rich_traceback (show_locals=True)
    whenever the rich package is installed, which would print every local
    variable in every frame -- request bodies, passwords, tokens -- straight
    to the console/container logs. We want the same frame-by-frame Rich
    rendering, just never with locals. No plain formatted traceback string
    is the JSONL/broadcast contract either way (see _capture_exc_info); this
    only affects what the human-facing console shows.
    """
    if structlog.dev.rich is not None:
        return structlog.dev.RichTracebackFormatter(show_locals=False)
    return structlog.dev.plain_traceback


def _console_renderer() -> structlog.dev.ConsoleRenderer:
    styles = structlog.dev.ConsoleRenderer.get_default_level_styles(colors=True)
    styles["success"] = "\x1b[32m"  # green, matches the UI emerald badge
    styles["debug"] = "\x1b[2m"  # dim/grey, was green (indistinguishable from info)
    styles["info"] = "\x1b[34m"  # blue, was green (indistinguishable from debug)
    styles["critical"] = "\x1b[1m\x1b[31m"  # bold red, stands out from plain error red
    return structlog.dev.ConsoleRenderer(
        colors=True,
        level_styles=styles,
        exception_formatter=_console_exception_formatter(),
    )


def _log_dir_write_error(log_dir: "Path") -> str | None:
    """Try to create log_dir and confirm it is actually writable.

    Returns None when the directory is usable, otherwise a short
    human-readable description of the OSError that prevented it.
    """
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        probe = log_dir / ".write_probe"
        probe.write_text("")
        probe.unlink()
    except OSError as exc:
        return f"{exc.strerror or exc} (errno={exc.errno})"
    return None


def create_logging_config(settings: "Settings") -> StructLoggingConfig:
    """Full pipeline: console + JSONL file + login file + WS broadcast.

    Everything hangs off the stdlib queue listener; structlog and foreign
    (stdlib) records meet in ProcessorFormatter so all sinks see both.
    """
    register_success_level()
    log_dir = settings.log.dir
    write_error = _log_dir_write_error(log_dir)
    file_logging_enabled = write_error is None

    if not file_logging_enabled:
        print(
            f"ERROR: log directory {log_dir} is not writable ({write_error}); "
            "file logging is DISABLED, including login.log, until this is "
            "fixed. Console logging continues. Fix ownership/permissions "
            "(e.g. `chown 1000:1000` for the container's geometrikks user, "
            "or the equivalent for a non-default uid) and restart to "
            "re-enable file logging.",
            file=sys.stderr,
            flush=True,
        )

    shared = _shared_processors()
    fmt = structlog.stdlib.ProcessorFormatter

    def formatter(renderer: Any, *, format_exception: bool = True) -> dict[str, Any]:
        # format_exception=False (console): exc_info reaches the renderer as a
        # real (type, value, traceback) tuple (captured by _capture_exc_info
        # above, shared by every formatter's foreign_pre_chain) and
        # ConsoleRenderer formats it itself, producing a pretty, colorized
        # traceback instead of a plain string.
        processors: list[Any] = [fmt.remove_processors_meta]
        if format_exception:
            processors.append(structlog.processors.format_exc_info)
        processors.append(renderer)
        return {
            "()": fmt,
            "processors": processors,
            "foreign_pre_chain": shared,
        }

    handlers: dict[str, Any] = {
        "console": {
            "class": "logging.StreamHandler",
            "level": "DEBUG",
            "formatter": "console",
        },
        "broadcast": {
            "()": BroadcastHandler,
            "level": "DEBUG",
            "formatter": "json",
        },
    }
    queue_targets = ["console", "broadcast"]

    if file_logging_enabled:
        handlers["main_file"] = {
            "()": GzipRotatingFileHandler,
            "level": "DEBUG",
            "formatter": "json",
            "filename": str(log_dir / MAIN_LOG_NAME),
            "maxBytes": settings.log.main_max_bytes,
            "backupCount": settings.log.main_backup_count,
            "encoding": "utf-8",
        }
        handlers["login_file"] = {
            "()": GzipRotatingFileHandler,
            "level": "INFO",
            "formatter": "login",
            "filters": ["login_only"],
            "filename": str(log_dir / LOGIN_LOG_NAME),
            "maxBytes": settings.log.login_max_bytes,
            "backupCount": settings.log.login_backup_count,
            "encoding": "utf-8",
        }
        queue_targets = ["console", "main_file", "login_file", "broadcast"]

    handlers["queue_listener"] = {
        "class": NonBlockingQueueHandler,
        "queue": {"()": "queue.Queue", "maxsize": -1},
        "listener": "litestar.logging.standard.LoggingQueueListener",
        "handlers": queue_targets,
        "respect_handler_level": True,
    }

    standard_lib = LoggingConfig(
        formatters={
            "console": formatter(_console_renderer(), format_exception=False),
            "json": formatter(structlog.processors.JSONRenderer()),
            "login": formatter(render_login_line),
        },
        filters={"login_only": {"()": LoginOnlyFilter}},
        handlers=handlers,
        loggers={
            "litestar": {
                "level": settings.log.level or "INFO",
                "handlers": ["queue_listener"],
                "propagate": False,
            },
            LOGIN_LOGGER_NAME: {"level": "INFO"},
        },
        root={"level": settings.log.level or "INFO", "handlers": ["queue_listener"]},
        log_exceptions="always",
    )

    return StructLoggingConfig(
        processors=shared + [fmt.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=SuccessBoundLogger,
        standard_lib_logging_config=standard_lib,
        log_exceptions="always",
    )
