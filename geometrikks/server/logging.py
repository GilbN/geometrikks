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
from logging.handlers import RotatingFileHandler
from typing import Any

import structlog

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

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.namer = _gz_namer
        self.rotator = _gzip_rotator


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
