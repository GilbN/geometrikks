"""Tail one access-log file."""
from __future__ import annotations

import asyncio
import io
import os
from collections.abc import AsyncGenerator
from pathlib import Path

import aiofiles
import aiofiles.os

from geometrikks.lib.utils import sleep_unless_stopped, wait_for_path
from geometrikks.server.logging import get_logger

from .base import SourceStatus

logger = get_logger(__name__)

MISSING_FILE_GRACE_SECONDS = 60.0
_TAIL_BLOCK_BYTES = 4096


class FileSource:
    """A log file on disk, followed like ``tail -F``."""

    kind = "file"

    def __init__(
        self, path: Path, poll_interval: float = 1.0, *, start_at_end: bool = True
    ) -> None:
        """Set up the source.

        Args:
            path: The log file to tail.
            poll_interval: Seconds between checks for new lines.
            start_at_end: If True, reading starts at the position recorded by
                wait_ready, or at the current end when lines() is called
                without it. If False, read from the beginning.
        """
        self.path: Path = path
        self.label: str = str(path)
        self.poll_interval: int | float = poll_interval
        self.start_at_end: bool = start_at_end
        # True while the configured file is absent. This is surfaced through
        # LogIngestionService.missing_files into /health.
        self._missing: bool = False
        # (inode, size) of the file when wait_ready returned. The first open
        # in lines() starts there, so lines written while the service was
        # checking the format are not skipped. None means "start at the end".
        self._ready_position: tuple[int, int] | None = None

    def status(self) -> SourceStatus:
        if self._missing:
            return SourceStatus(available=False, reason="missing")
        return SourceStatus(available=True)

    def _mark_missing_at_start(self) -> None:
        """Flag the file as absent and expose it through health status."""
        if not self._missing:
            logger.error(
                "Log file does not exist: %s - waiting for it to appear", self.path
            )
            self._missing = True

    def _mark_missing(self, err: OSError) -> None:
        """Record a mid-flight absence with the operating system error."""
        if not self._missing:
            logger.error(
                "Log file no longer exists or cannot be read: %s - "
                "waiting for it to reappear (%s)",
                self.path,
                err,
            )
            self._missing = True

    def _mark_present(self) -> None:
        """Clear the missing flag, logging the recovery once."""
        if self._missing:
            logger.info("Log file reappeared, resuming tail: %s", self.path)
            self._missing = False

    async def _record_ready_position(self) -> None:
        """Remember the file's identity and size for the first open in lines()."""
        try:
            stat_result = await aiofiles.os.stat(self.path)
        except OSError:
            # Vanished since the existence check. No real inode matches this
            # one, so whatever appears at the path is read from the start.
            self._ready_position = (-1, 0)
            return
        self._ready_position = (stat_result.st_ino, stat_result.st_size)

    async def wait_ready(self, stop: asyncio.Event) -> bool:
        logger.debug("Waiting for log file: %s", self.path)
        self._ready_position = None
        if not await wait_for_path(
            self.path,
            timeout_seconds=MISSING_FILE_GRACE_SECONDS,
            stop_event=stop,
        ):
            if stop.is_set():
                return False  # shutting down, not a missing-file problem
            self._mark_missing_at_start()
            while not await aiofiles.os.path.exists(self.path):
                if await sleep_unless_stopped(self.poll_interval, stop):
                    return False
            self._mark_present()
        await self._record_ready_position()
        return True

    def _read_recent(self, count: int) -> list[str]:
        """Read the last ``count`` lines of the file.

        Blocking (opens and reads the file); callers on the event loop go
        through ``recent_lines`` instead of calling this directly.
        """
        with open(self.path, "rb") as f:
            position = f.seek(0, os.SEEK_END)
            block = _TAIL_BLOCK_BYTES
            data = b""
            # One newline more than asked for: the oldest piece read may be
            # the back half of a line, and the slice below drops it.
            while position > 0 and data.count(b"\n") <= count:
                step = min(block, position)
                position -= step
                f.seek(position)
                data = f.read(step) + data
                block *= 2
        # Not str.splitlines(): it also breaks on U+2028, \x0b and friends,
        # which are legal inside a JSON log line. A text wrapper splits the
        # way the tail loop's text-mode file does.
        text = io.TextIOWrapper(io.BytesIO(data), encoding="utf-8", errors="replace")
        return list(text)[-count:]

    async def recent_lines(self, count: int) -> list[str]:
        if count <= 0:
            return []
        try:
            lines = await asyncio.to_thread(self._read_recent, count)
        except OSError as e:
            self._mark_missing(e)
            return []
        # A source restarted in-process can still carry the flag from before
        # it stopped, and format validation trusts it.
        self._mark_present()
        return lines

    async def _is_rotated(self, prev_stat: os.stat_result) -> bool:
        """Check if the log file was rotated.

        Detects rotation via:
        - Inode change (file replaced)
        - Size decrease of >=99% (file truncated)
        """
        if os.getenv("DISABLE_ROTATION_CHECK", "false").lower() == "true":
            return False
        try:
            new_stat = await aiofiles.os.stat(self.path)
        except OSError as e:
            # Deleted/moved mid-tail: log once, keep polling. When the file
            # reappears the inode-change branch below reopens it.
            self._mark_missing(e)
            return False
        self._mark_present()

        # Inode changed
        if new_stat.st_ino != prev_stat.st_ino:
            logger.info(
                "Log file inode changed: %s -> %s", prev_stat.st_ino, new_stat.st_ino
            )
            return True

        # Size decreased by >=99%
        if new_stat.st_size < prev_stat.st_size and prev_stat.st_size > 0:
            decrease_pct = (
                (prev_stat.st_size - new_stat.st_size) / prev_stat.st_size
            ) * 100.0
            if decrease_pct >= 99.0:
                logger.info(
                    "Log file rotated (size: %d -> %d, decrease=%.1f%%)",
                    prev_stat.st_size,
                    new_stat.st_size,
                    decrease_pct,
                )
                return True

        return False

    @staticmethod
    def _start_offset(
        stat_result: os.stat_result, ready_position: tuple[int, int] | None
    ) -> int:
        """Where the first open starts reading."""
        if ready_position is None:
            return stat_result.st_size
        inode, size = ready_position
        # Rotated or truncated since wait_ready: the whole file is new. A
        # file truncated and rewritten past the recorded size cannot be told
        # from an append, and is read from the recorded offset.
        if stat_result.st_ino != inode or stat_result.st_size < size:
            return 0
        return size

    async def lines(self, stop: asyncio.Event) -> AsyncGenerator[str, None]:
        """Async generator that tails the log file and yields each new line.

        This is a native async implementation using aiofiles for non-blocking I/O.
        On log rotation, reopens the file in a loop instead of recursing.

        Yields:
            Each raw line as it is written, line ending included.
        """
        seek_to_end = self.start_at_end
        while not stop.is_set():
            # Stat before (re)opening: after a rotation break the new file may
            # not exist yet, and crashing here would kill the tail task.
            try:
                await aiofiles.os.stat(self.path)
            except OSError as e:
                self._mark_missing(e)
                await asyncio.sleep(self.poll_interval)
                continue

            # The file can vanish between the stat above and this open.
            try:
                file = await aiofiles.open(
                    self.path, "r", encoding="utf-8", errors="replace"
                )
            except OSError as e:
                self._mark_missing(e)
                await asyncio.sleep(self.poll_interval)
                continue
            self._mark_present()

            try:
                # Stat the descriptor, not the stat above: the path can be
                # rotated between that stat and the open, and the rotation
                # check must compare against the file being read.
                stat_result = await aiofiles.os.stat(file.fileno())
                if seek_to_end:
                    await file.seek(self._start_offset(stat_result, self._ready_position))
                # After a rotation we always read the new file from the start
                seek_to_end = False
                self._ready_position = None

                logger.info("Streaming log file events (async): %s", self.path)

                while not stop.is_set():
                    line = await file.readline()

                    if not line:
                        # No new data
                        await asyncio.sleep(self.poll_interval)

                        if await self._is_rotated(stat_result):
                            logger.info(
                                "Log rotation detected, reopening from start: %s",
                                self.path,
                            )
                            break  # close this file; outer loop reopens
                        continue

                    # The baseline tracks the file being read, so its size keeps
                    # up with growth and a replacement at the path is seen as a
                    # rotation. If the stat fails, the previous baseline stays.
                    try:
                        stat_result = await aiofiles.os.stat(file.fileno())
                    except OSError:
                        pass

                    yield line
            finally:
                await file.close()
