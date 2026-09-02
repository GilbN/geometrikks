"""widen HTTP method columns for the IANA registry

Revision ID: 8b7884d1daaf
Revises: d4e8f2a6b913
Create Date: 2026-09-02 00:00:00.000000

TimescaleDB cannot change a column type while a hypertable has compressed
chunks. Existing installations therefore decompress both method-bearing
hypertables first. The configured compression policy recompresses eligible
chunks after startup. Each chunk is decompressed in its own autocommit
statement. If startup is interrupted, Alembic reruns the unstamped revision
and selects only chunks that are still compressed; repeating the target type
change is harmless.
"""

from __future__ import annotations

import warnings

import sqlalchemy as sa
from alembic import op
from sqlalchemy.engine import Connection

from geometrikks.server.logging import get_logger

revision = "8b7884d1daaf"
down_revision = "d4e8f2a6b913"
branch_labels = None
depends_on = None

TABLES = ("access_logs", "access_log_debug")
logger = get_logger(__name__)


def upgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            logger.warning(
                "HTTP method column migration started; compressed chunks must be "
                "decompressed, so startup may take several minutes on a large database."
            )
            _decompress_method_tables(op.get_bind())
            for table in TABLES:
                op.execute(f"ALTER TABLE {table} ALTER COLUMN method TYPE VARCHAR(32)")
            logger.info("HTTP method column migration completed.")


def downgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            bind = op.get_bind()
            _refuse_lossy_downgrade(bind)
            _decompress_method_tables(bind)
            for table in TABLES:
                op.execute(f"ALTER TABLE {table} ALTER COLUMN method TYPE VARCHAR(10)")


def _decompress_method_tables(bind: Connection) -> None:
    has_timescale = bind.execute(
        sa.text("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')")
    ).scalar()
    if not has_timescale:
        return

    for table in TABLES:
        is_hypertable = bind.execute(
            sa.text(
                "SELECT EXISTS ("
                "SELECT 1 FROM timescaledb_information.hypertables "
                "WHERE hypertable_schema = current_schema() AND hypertable_name = :table"
                ")"
            ),
            {"table": table},
        ).scalar()
        if not is_hypertable:
            continue
        chunks = bind.execute(
            sa.text(
                "SELECT format('%I.%I', chunk_schema, chunk_name) "
                "FROM timescaledb_information.chunks "
                "WHERE hypertable_schema = current_schema() "
                "AND hypertable_name = :table AND is_compressed "
                "ORDER BY range_start"
            ),
            {"table": table},
        ).scalars().all()
        if not chunks:
            logger.info("No compressed chunks need decompression.", table=table)
            continue

        logger.warning(
            "Decompressing chunks for HTTP method column migration.",
            table=table,
            total=len(chunks),
        )
        for completed, chunk in enumerate(chunks, start=1):
            bind.execute(
                sa.text("SELECT decompress_chunk(CAST(:chunk AS regclass), true)"),
                {"chunk": chunk},
            )
            logger.info(
                "HTTP method column migration decompression progress.",
                table=table,
                chunk=chunk,
                completed=completed,
                total=len(chunks),
            )


def _refuse_lossy_downgrade(bind: Connection) -> None:
    for table in TABLES:
        has_long_method = bind.execute(
            sa.text(f"SELECT EXISTS (SELECT 1 FROM {table} WHERE char_length(method) > 10)")
        ).scalar()
        if has_long_method:
            raise RuntimeError(
                f"cannot narrow {table}.method to VARCHAR(10): values longer than 10 characters exist"
            )
