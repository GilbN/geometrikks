"""Enumerate, resolve and tail application/nginx log files.

resolve() is the download allowlist: a (kind, name) pair is only served if
list_files() enumerates it, so no client-supplied path ever hits the
filesystem directly.
"""

from __future__ import annotations

import json
import os
import re
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from geometrikks.server.logging import LOGIN_LOG_NAME, LOGIN_LOGGER_NAME, MAIN_LOG_NAME

_LOGIN_LINE_RE = re.compile(
    r'^(?P<timestamp>\S+) (?P<event>[A-Za-z0-9_]+) user="(?P<user>[^"]*)" ip=(?P<ip>\S+)$'
)

LogFileKind = Literal["app", "login", "nginx"]


@dataclass
class LogFileEntry:
    name: str
    kind: LogFileKind
    size_bytes: int
    modified_at: datetime | None
    available: bool


def _entry(path: Path, kind: LogFileKind, name: str | None = None) -> LogFileEntry:
    try:
        stat = path.stat()
        readable = os.access(path, os.R_OK)
        return LogFileEntry(
            name=name or path.name,
            kind=kind,
            size_bytes=stat.st_size,
            modified_at=datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc),
            available=readable,
        )
    except OSError:
        return LogFileEntry(
            name=name or path.name, kind=kind, size_bytes=0, modified_at=None, available=False
        )


class LogFilesService:
    def __init__(self, log_dir: Path, nginx_paths: list[Path]) -> None:
        self._log_dir = log_dir
        self._nginx_paths = nginx_paths

    def _candidates(self) -> list[tuple[LogFileEntry, Path]]:
        pairs: list[tuple[LogFileEntry, Path]] = []
        for stem, kind in ((MAIN_LOG_NAME, "app"), (LOGIN_LOG_NAME, "login")):
            active = self._log_dir / stem
            if active.exists():
                pairs.append((_entry(active, kind), active))
            for archive in sorted(self._log_dir.glob(f"{stem}.*.gz")):
                pairs.append((_entry(archive, kind), archive))
        seen: dict[str, int] = {}
        for path in self._nginx_paths:
            name = path.name
            if name in seen:  # two configured paths with the same basename
                seen[name] += 1
                name = f"{path.name}.{seen[path.name]}"
            else:
                seen[name] = 1
            entry = _entry(path, "nginx", name=name)
            if not path.is_file():
                entry.available = False
            pairs.append((entry, path))
        return pairs

    def list_files(self) -> list[LogFileEntry]:
        return [entry for entry, _ in self._candidates()]

    def resolve(self, kind: str, name: str) -> Path | None:
        """Allowlisted download resolution; None for anything not listed."""
        for entry, path in self._candidates():
            if entry.kind == kind and entry.name == name and entry.available:
                return path
        return None

    def tail_main(self, lines: int) -> list[dict[str, Any]]:
        """Last N parsed JSONL records of the main log; malformed lines skipped."""
        main = self._log_dir / MAIN_LOG_NAME
        if not main.is_file():
            return []
        with main.open("r", encoding="utf-8", errors="replace") as fh:
            raw = deque(fh, maxlen=lines)
        records: list[dict[str, Any]] = []
        for line in raw:
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                records.append(parsed)
        return records

    def tail_login(self, lines: int) -> list[dict[str, Any]]:
        """Last N parsed records of the plain-text login log; malformed lines skipped."""
        login = self._log_dir / LOGIN_LOG_NAME
        if not login.is_file():
            return []
        with login.open("r", encoding="utf-8", errors="replace") as fh:
            raw = deque(fh, maxlen=lines)
        records: list[dict[str, Any]] = []
        for line in raw:
            match = _LOGIN_LINE_RE.match(line.rstrip("\r\n"))
            if match is None:
                continue
            event = match.group("event")
            ip = match.group("ip")
            record: dict[str, Any] = {
                "timestamp": match.group("timestamp"),
                "level": "warning" if event == "login_failed" else "info",
                "event": event,
                "logger": LOGIN_LOGGER_NAME,
                "user": match.group("user"),
            }
            if ip != "-":
                record["ip"] = ip
            records.append(record)
        return records


def create_log_files_service() -> LogFilesService:
    from geometrikks.config.settings import get_settings

    settings = get_settings()
    return LogFilesService(
        log_dir=settings.log.dir,
        nginx_paths=list(settings.logparser.log_paths),
    )
