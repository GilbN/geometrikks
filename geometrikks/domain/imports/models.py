"""Import job bookkeeping for batch log imports (duplicate protection)."""
from datetime import datetime

from sqlalchemy import BigInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from advanced_alchemy.types import DateTimeUTC
from advanced_alchemy import base


class ImportJob(base.BigIntAuditBase):
    """One completed batch import of a historical log file.

    checksum is the sha256 of the file content; re-importing a file with a
    known checksum is refused (unless --force). Note: a file that was also
    live-tailed will still double-count — documented limitation.
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
