"""The boundary between where log lines come from and how they are parsed."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class SourceStatus:
    available: bool
    # Short machine-readable cause when unavailable, e.g. "missing". Served on
    # the unauthenticated /health, so it must be a short fixed word, never an
    # exception message or a URL.
    reason: str | None = None


class LogSource(Protocol):
    """One place raw access-log lines are read from.

    Position, retries and any overlap handling live inside the source; the
    ingestion service only ever sees lines.
    """

    kind: str
    # Served on the unauthenticated /health. A source whose configuration is
    # sensitive must use an opaque label here.
    label: str
    # Stamped on every record read from this source. Empty means the source
    # has none of its own and the ingestion service's default applies.
    hostname: str

    def status(self) -> SourceStatus:
        """Current availability. Called on every /health request: no I/O."""
        ...

    async def wait_ready(self, stop: asyncio.Event) -> bool:
        """Block until lines can be served; False when stop was set first."""
        ...

    async def recent_lines(self, count: int) -> list[str] | None:
        """Up to ``count`` of the newest lines, without consuming them.

        Used for format detection. [] means there are no lines yet. A source
        that has no way to sample returns None, and its format is then not
        validated before reading starts.
        """
        ...

    def lines(self, stop: asyncio.Event) -> AsyncIterator[str]:
        """Yield each new raw line once, until stop is set.

        Lines that arrive after wait_ready returned are yielded, however long
        the caller waits before starting to read. If the underlying log is
        replaced in that window, reading starts from the replacement.

        Conditions the source can retry are recorded in status(), not raised.
        """
        ...
