"""Import job bookkeeping for batch log imports: files by checksum, Loki by time range."""
from datetime import datetime

from sqlalchemy import BigInteger, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from advanced_alchemy.types import DateTimeUTC
from advanced_alchemy import base


class ImportJob(base.BigIntAuditBase):
    """One completed batch import of a historical log file.

    checksum is the sha256 of the file content; re-importing a file with a
    known checksum is refused (unless --force). Note: a file that was also
    live-tailed will still double-count — documented limitation.

    cutoff is the --before the file was imported with: lines stamped at or
    after it were left out. NULL means the whole file was imported. A later
    run with a later cutoff imports only the lines in between.
    """

    __tablename__ = "import_jobs"

    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    # unique constraint provides the index
    checksum: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    lines_total: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    lines_skipped: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    records_written: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    time_start: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)
    time_end: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)
    cutoff: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)


class LokiImport(base.BigIntAuditBase):
    """One import-loki run over a time range of one selector.

    A selector is identified by (url, tenant_id, query); hostname is what
    the rows were stamped with and is not part of the identity, so changing
    LOKI_HOST_NAMES does not hide an earlier import of the same data.

    cursor is the start of the next window to read and equals range_end
    once the run completed. A rerun with the same range resumes from it.
    Each window's rows commit before the cursor moves, so a crash between
    the two re-imports that hour on resume.
    """

    __tablename__ = "loki_imports"
    __table_args__ = (Index("ix_loki_imports_url_query", "url", "query"),)

    url: Mapped[str] = mapped_column(Text, nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    hostname: Mapped[str] = mapped_column(String(255), nullable=False)
    range_start: Mapped[datetime] = mapped_column(DateTimeUTC(timezone=True), nullable=False)
    range_end: Mapped[datetime] = mapped_column(DateTimeUTC(timezone=True), nullable=False)
    cursor: Mapped[datetime] = mapped_column(DateTimeUTC(timezone=True), nullable=False)
    lines_total: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    lines_skipped: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    records_written: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    time_start: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)
    time_end: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)
