"""Structlog logging pipeline building blocks.

Sinks (wired in create_logging_config, Task 6): colored console, JSONL main
file, plain-text login file (CrowdSec/fail2ban contract), and a WebSocket
fan-out. All sit behind the stdlib queue listener so file IO and gzip never
block the event loop.
"""

from __future__ import annotations

import logging
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
