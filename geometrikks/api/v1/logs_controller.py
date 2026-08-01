"""Application log endpoints: tail for the UI table, file list, downloads."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal

from litestar import Controller, get, post
from litestar.exceptions import NotFoundException
from litestar.params import FromPath, QueryParameter
from litestar.response import File

from geometrikks.server.logging import rotate_log_files
from geometrikks.services.logfiles import LogFileKind, create_log_files_service

MAX_TAIL_LINES = 2000


@dataclass
class LogFileView:
    name: str
    kind: LogFileKind
    size_bytes: int
    modified_at: datetime | None
    available: bool


@dataclass
class LogFilesResponse:
    files: list[LogFileView]


@dataclass
class LogTailResponse:
    records: list[dict[str, Any]]


@dataclass
class LogRotateResponse:
    rotated: list[str]


class LogsController(Controller):
    """Access to the application's own log files: tail, list, download, rotate."""

    path = "/api/v1/logs"
    tags = ["Logs"]

    @get("/tail", sync_to_thread=True)
    def tail(
        self,
        lines: Annotated[int, QueryParameter(description="Number of records to return (capped)")] = 500,
        source: Annotated[
            Literal["app", "login"], QueryParameter(description="Which log to tail")
        ] = "app",
    ) -> LogTailResponse:
        clamped = max(1, min(lines, MAX_TAIL_LINES))
        service = create_log_files_service()
        if source == "login":
            records = service.tail_login(lines=clamped)
        else:
            records = service.tail_main(lines=clamped)
        return LogTailResponse(records=records)

    @get("/files", sync_to_thread=True)
    def list_files(self) -> LogFilesResponse:
        return LogFilesResponse(
            files=[
                LogFileView(
                    name=e.name,
                    kind=e.kind,
                    size_bytes=e.size_bytes,
                    modified_at=e.modified_at,
                    available=e.available,
                )
                for e in create_log_files_service().list_files()
            ]
        )

    @get("/files/{kind:str}/{name:str}", sync_to_thread=True)
    def download(self, kind: FromPath[str], name: FromPath[str]) -> File:
        path = create_log_files_service().resolve(kind, name)
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
