"""Application log endpoints: tail for the UI table, file list, downloads."""

from __future__ import annotations

import msgspec
from datetime import datetime
from typing import Annotated, Literal

from litestar import Controller, get, post
from litestar.di import NamedDependency
from litestar.exceptions import NotFoundException
from litestar.params import FromPath, QueryParameter, SkipValidation
from litestar.response import File

from geometrikks.config.settings import Settings
from geometrikks.server.logging import rotate_log_files
from geometrikks.services.logfiles import (
    LogFileKind,
    LogTailRecord,
    create_log_files_service,
)

MAX_TAIL_LINES = 2000


class LogFileView(msgspec.Struct, rename="camel"):
    name: str
    kind: LogFileKind
    size_bytes: int
    modified_at: datetime | None
    available: bool


class LogFilesResponse(msgspec.Struct, rename="camel"):
    files: list[LogFileView]


class LogTailResponse(msgspec.Struct, rename="camel"):
    # LogTailRecord is a TypedDict: app-log records keep their extra
    # structlog context keys on the wire; the schema documents the stable ones.
    records: list[LogTailRecord]


class LogRotateResponse(msgspec.Struct, rename="camel"):
    rotated: list[str]


class LogsController(Controller):
    """Access to the application's own log files: tail, list, download, rotate."""

    path = "/logs"
    tags = ["Logs"]

    @get("/tail", sync_to_thread=True)
    def tail(
        self,
        settings: NamedDependency[SkipValidation[Settings]],
        lines: Annotated[int, QueryParameter(description="Number of records to return (capped)")] = 500,
        source: Annotated[
            Literal["app", "login"], QueryParameter(description="Which log to tail")
        ] = "app",
    ) -> LogTailResponse:
        clamped = max(1, min(lines, MAX_TAIL_LINES))
        service = create_log_files_service(settings)
        if source == "login":
            records = service.tail_login(lines=clamped)
        else:
            records = service.tail_main(lines=clamped)
        return LogTailResponse(records=records)

    @get("/files", sync_to_thread=True)
    def list_files(
        self, settings: NamedDependency[SkipValidation[Settings]]
    ) -> LogFilesResponse:
        return LogFilesResponse(
            files=[
                LogFileView(
                    name=e.name,
                    kind=e.kind,
                    size_bytes=e.size_bytes,
                    modified_at=e.modified_at,
                    available=e.available,
                )
                for e in create_log_files_service(settings).list_files()
            ]
        )

    @get("/files/{kind:str}/{name:str}", sync_to_thread=True)
    def download(
        self,
        kind: FromPath[str],
        name: FromPath[str],
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> File:
        path = create_log_files_service(settings).resolve(kind, name)
        if path is None:
            raise NotFoundException(detail="No such log file")
        return File(
            path=path,
            filename=path.name,
            content_disposition_type="attachment",
            media_type="application/gzip" if path.suffix == ".gz" else "text/plain",
        )

    @post("/rotate", sync_to_thread=True)
    def rotate(self) -> LogRotateResponse:
        return LogRotateResponse(rotated=rotate_log_files())
