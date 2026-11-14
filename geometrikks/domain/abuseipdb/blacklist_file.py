"""Read an AbuseIPDB blacklist that something else downloads: the API's JSON answer, or one IP per line."""
from __future__ import annotations

import asyncio
import os
import stat
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

import aiofiles.os

from geometrikks.services.abuseipdb import (
    BlacklistFormatError,
    BlacklistResult,
    canonical_global_ip,
    parse_blacklist_json,
)

if TYPE_CHECKING:
    from pathlib import Path

MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_FILE_IPS = 100_000
FILE_CHECK_MINUTES = 5
FUTURE_TOLERANCE = timedelta(minutes=5)

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


class BlacklistFileError(Exception):
    """The blacklist file is missing, unreadable or holds no usable list."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


def _os_error_detail(error: OSError) -> str:
    if isinstance(error, FileNotFoundError):
        return "the file does not exist"
    if isinstance(error, PermissionError):
        return "permission denied reading the file"
    if isinstance(error, IsADirectoryError):
        return "the path is a directory"
    return f"the file can't be read: {error.strerror or type(error).__name__}"


def _too_large() -> BlacklistFileError:
    return BlacklistFileError(f"the file is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB")


def _checked_modified_at(file_stat: os.stat_result, *, now: datetime) -> datetime:
    """When the file was last written, to the microsecond, so it compares equal to the stored time."""
    if stat.S_ISDIR(file_stat.st_mode):
        raise BlacklistFileError("the path is a directory")
    if not stat.S_ISREG(file_stat.st_mode):
        raise BlacklistFileError("the path is not a regular file")
    if file_stat.st_size > MAX_FILE_BYTES:
        raise _too_large()
    modified_at = _EPOCH + timedelta(microseconds=file_stat.st_mtime_ns // 1000)
    # The 72-hour expiry counts from this time, so a future one would keep the list showing.
    if modified_at > now + FUTURE_TOLERANCE:
        raise BlacklistFileError("the file was modified in the future")
    return modified_at


async def blacklist_file_modified_at(path: Path, *, now: datetime) -> datetime:
    try:
        file_stat = await aiofiles.os.stat(path)
    except OSError as error:
        raise BlacklistFileError(_os_error_detail(error)) from None
    return _checked_modified_at(file_stat, now=now)


def _read_open_file(path: Path, now: datetime) -> tuple[datetime, bytes]:
    # Without O_NONBLOCK, a FIFO swapped in after the stat would block the open until a writer appears.
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    try:
        modified_at = _checked_modified_at(os.fstat(descriptor), now=now)
        with open(descriptor, "rb", closefd=False) as blacklist_file:
            body = blacklist_file.read(MAX_FILE_BYTES + 1)
    finally:
        os.close(descriptor)
    if len(body) > MAX_FILE_BYTES:
        raise _too_large()
    return modified_at, body


async def read_blacklist_file(path: Path, *, now: datetime) -> tuple[datetime, bytes]:
    """The file's bytes and the modification time of that same open file, which a rename can't split."""
    try:
        return await asyncio.to_thread(_read_open_file, path, now)
    except OSError as error:
        raise BlacklistFileError(_os_error_detail(error)) from None


def _plaintext_ips(body: bytes) -> list[str]:
    ips: list[str] = []
    for line in body.decode("utf-8", errors="replace").splitlines():
        fields = line.split("#", 1)[0].split()
        if fields and (ip := canonical_global_ip(fields[0])) is not None:
            ips.append(ip)
    return list(dict.fromkeys(ips))


def parse_blacklist_file(body: bytes, *, modified_at: datetime) -> BlacklistResult:
    """Parse either format. Plaintext carries no generation time, so the file's modification time stands in."""
    # PowerShell 5.1 starts its UTF-8 output with a byte order mark.
    body = body.removeprefix(b"\xef\xbb\xbf")
    if body.lstrip()[:1] == b"{":
        try:
            result = parse_blacklist_json(body)
        except BlacklistFormatError:
            raise BlacklistFileError("the file is not AbuseIPDB's JSON blacklist") from None
    else:
        result = BlacklistResult(generated_at=modified_at, ips=_plaintext_ips(body))
    if not result.ips:
        raise BlacklistFileError("the file holds no public IPs")
    return result
