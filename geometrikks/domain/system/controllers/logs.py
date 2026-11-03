"""Application log endpoints: tail for the UI table, file list, downloads."""

from __future__ import annotations

import msgspec
from datetime import datetime
from typing import Annotated, Literal

from litestar import Controller, get, post
from litestar.di import NamedDependency
from litestar.exceptions import NotFoundException
from litestar.params import PathParameter, QueryParameter, SkipValidation
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
    """A log file on this server."""

    name: Annotated[
        str,
        msgspec.Meta(
            description=(
                "The file name the download endpoint takes. A second access log with the same file name "
                "gets a `.2` suffix, a third `.3`."
            )
        ),
    ]
    kind: Annotated[
        LogFileKind,
        msgspec.Meta(description="`app` for geometrikks.log, `login` for login.log, `access` for a tailed access log."),
    ]
    size_bytes: Annotated[int, msgspec.Meta(description="The file size in bytes. Zero when the file is missing.")]
    modified_at: Annotated[datetime | None, msgspec.Meta(description="Null when the file is missing.")]
    available: Annotated[
        bool,
        msgspec.Meta(
            description="Whether the file exists and is readable. The download endpoint serves only available files."
        ),
    ]


class LogFilesResponse(msgspec.Struct, rename="camel"):
    """The log files on this server."""

    files: list[LogFileView]


class LogTailResponse(msgspec.Struct, rename="camel"):
    """The newest records of one log, oldest first."""

    # LogTailRecord is a TypedDict: app-log records keep their extra
    # structlog context keys on the wire; the schema documents the stable ones.
    records: list[LogTailRecord]


class LogRotateResponse(msgspec.Struct, rename="camel"):
    """The log files that rotated."""

    rotated: Annotated[list[str], msgspec.Meta(description="Their file names, such as `geometrikks.log`.")]


class LogsController(Controller):
    """Access to the application's own log files: tail, list, download, rotate."""

    path = "/logs"
    tags = ["Logs"]

    @get(
        "/tail",
        sync_to_thread=True,
        summary="Get the newest app or login log records",
        description=(
            "Returns the last `lines` lines of geometrikks.log or login.log as records, oldest first. It skips "
            "lines that do not parse, so fewer records can come back. App log records keep every key the "
            "event carried, so expect more keys than the schema lists."
        ),
    )
    def tail(
        self,
        settings: NamedDependency[SkipValidation[Settings]],
        lines: Annotated[
            int,
            QueryParameter(
                description=(
                    f"How many lines to read from the end of the log, from 1 to {MAX_TAIL_LINES}. The server "
                    "clamps a value outside that range to the nearest end. Defaults to 500."
                )
            ),
        ] = 500,
        source: Annotated[
            Literal["app", "login"],
            QueryParameter(description="`app` reads geometrikks.log, `login` reads login.log. Defaults to `app`."),
        ] = "app",
    ) -> LogTailResponse:
        clamped = max(1, min(lines, MAX_TAIL_LINES))
        service = create_log_files_service(settings)
        if source == "login":
            records = service.tail_login(lines=clamped)
        else:
            records = service.tail_main(lines=clamped)
        return LogTailResponse(records=records)

    @get(
        "/files",
        sync_to_thread=True,
        summary="List the log files you can download",
        description=(
            "Lists geometrikks.log and login.log with their rotated `.gz` archives, then every access log in "
            "LOGPARSER_LOG_PATHS. An access log that is missing or unreadable still appears, with `available` "
            "false. With LOGPARSER_ENABLED=false the list has no access logs."
        ),
    )
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

    @get(
        "/files/{kind:str}/{name:str}",
        sync_to_thread=True,
        summary="Download a log file",
        description=(
            "Sends the file as an attachment, as gzip for a `.gz` archive and as plain text otherwise. You can "
            "download only a file the file list shows as available. Anything else gets a 404."
        ),
    )
    def download(
        self,
        kind: Annotated[str, PathParameter(description="`app`, `login` or `access`, as the file list gives it.")],
        name: Annotated[str, PathParameter(description="The file's `name` from the file list.")],
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

    @post(
        "/rotate",
        sync_to_thread=True,
        summary="Rotate the app and login logs now",
        description=(
            "Starts fresh log files and gzips the old ones into archives. It skips a log that is empty. "
            "Returns the names of the files that rotated. Needs a Read/write API key or a browser session."
        ),
    )
    def rotate(self) -> LogRotateResponse:
        return LogRotateResponse(rotated=rotate_log_files())
