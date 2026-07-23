"""Structlog logging pipeline building blocks.

Sinks (wired in create_logging_config, Task 6): colored console, JSONL main
file, plain-text login file (CrowdSec/fail2ban contract), and a WebSocket
fan-out. All sit behind the stdlib queue listener so file IO and gzip never
block the event loop.
"""

from __future__ import annotations

import gzip
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


def render_login_line(_: Any, __: str, event_dict: dict[str, Any]) -> str:
    """Stable plain-text login line for CrowdSec/fail2ban parsers.

    Contract (do not change without a deprecation cycle):
    YYYY-MM-DDTHH:MM:SSZ <event> user="<user>" ip=<ip>
    """
    ts = str(event_dict.get("timestamp", ""))[:19] + "Z"
    event = event_dict.get("event", "")
    user = str(event_dict.get("user", ""))
    ip = event_dict.get("ip") or "-"
    return f'{ts} {event} user="{user}" ip={ip}'


class LoginOnlyFilter(logging.Filter):
    """Routes only geometrikks.auth.login records into the login file."""

    def filter(self, record: logging.LogRecord) -> bool:
        return record.name == LOGIN_LOGGER_NAME
