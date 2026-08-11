"""add hostname and log_format columns to access_logs

Revision ID: b3fef8968d06
Revises: 5f1c8a7d24b3
Create Date: 2026-08-07 00:00:00.000000

"""

import warnings
from typing import TYPE_CHECKING

import sqlalchemy as sa
from alembic import op
from advanced_alchemy.types import Bool, EncryptedString, EncryptedText, GUID, JsonB, ORA_JSONB, DateTimeUTC, StoredObject, PasswordHash, FernetBackend, TOTPSecret, OneTimeCode
from advanced_alchemy.types.encrypted_string import PGCryptoBackend
from advanced_alchemy.types.password_hash.argon2 import Argon2Hasher
from advanced_alchemy.types.password_hash.passlib import PasslibHasher
from advanced_alchemy.types.password_hash.pwdlib import PwdlibHasher
from sqlalchemy import Text  # noqa: F401
from sqlalchemy.dialects import postgresql


if TYPE_CHECKING:
    from collections.abc import Sequence
    from sqlalchemy.engine import Connection

__all__ = ("downgrade", "upgrade", "schema_upgrades", "schema_downgrades", "data_upgrades", "data_downgrades")

sa.GUID = GUID
sa.Bool = Bool
sa.DateTimeUTC = DateTimeUTC
sa.JsonB = JsonB
sa.ORA_JSONB = ORA_JSONB
sa.EncryptedString = EncryptedString
sa.EncryptedText = EncryptedText
sa.StoredObject = StoredObject
sa.PasswordHash = PasswordHash
sa.Argon2Hasher = Argon2Hasher
sa.PasslibHasher = PasslibHasher
sa.PwdlibHasher = PwdlibHasher
sa.FernetBackend = FernetBackend
sa.PGCryptoBackend = PGCryptoBackend
sa.TOTPSecret = TOTPSecret
sa.OneTimeCode = OneTimeCode

# revision identifiers, used by Alembic.
revision = 'b3fef8968d06'
down_revision = '5f1c8a7d24b3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            schema_upgrades()
            data_upgrades()

def downgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            data_downgrades()
            schema_downgrades()

def schema_upgrades() -> None:
    """Add the source columns, tolerating a partially applied rerun.

    Each statement commits on its own (autocommit block), so a crash before
    alembic stamps the revision leaves the columns in place and reruns this
    on the next startup; plain ADD COLUMN would then fail with DuplicateColumn
    and take startup down with it.
    """
    op.execute("ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS hostname VARCHAR(255)")
    op.execute("ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS log_format VARCHAR(32)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_access_logs_hostname ON access_logs (hostname)")


def schema_downgrades() -> None:
    """Drop the source columns, and first the CAGG that reads them.

    log_source_daily_stats (created by server/timescale.py, not by alembic)
    selects hostname and log_format, so DROP COLUMN fails while it exists.
    Dropping it is safe: startup recreates it.
    """
    op.execute("DROP MATERIALIZED VIEW IF EXISTS log_source_daily_stats CASCADE")
    op.execute("DROP INDEX IF EXISTS ix_access_logs_hostname")
    op.execute("ALTER TABLE access_logs DROP COLUMN IF EXISTS log_format")
    op.execute("ALTER TABLE access_logs DROP COLUMN IF EXISTS hostname")


def _timescale_present(bind: "Connection") -> bool:
    return bool(bind.execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')"
    )).scalar())


def _decompress_access_logs(bind: "Connection") -> None:
    """Full-table UPDATEs on compressed chunks are pathological; decompress
    first and let the compression policy recompress on its own schedule."""
    bind.execute(sa.text("""
        SELECT decompress_chunk(format('%I.%I', chunk_schema, chunk_name)::regclass, true)
        FROM timescaledb_information.chunks
        WHERE hypertable_name = 'access_logs' AND is_compressed
    """))


def data_upgrades() -> None:
    """Backfill source columns where history makes the value provable.

    log_format: every pre-feature row was nginx-parsed by definition.
    hostname: only when geo_events shows exactly one distinct writer; a
    multi-writer DB cannot be attributed per row (the CLI command
    `litestar backfill-hostname` is the manual escape hatch).
    """
    bind = op.get_bind()
    if _timescale_present(bind):
        _decompress_access_logs(bind)

    op.execute("UPDATE access_logs SET log_format = 'nginx' WHERE log_format IS NULL")

    hosts = bind.execute(sa.text(
        "SELECT DISTINCT hostname FROM geo_events LIMIT 2"
    )).fetchall()
    if len(hosts) == 1:
        bind.execute(
            sa.text("UPDATE access_logs SET hostname = :h WHERE hostname IS NULL"),
            {"h": hosts[0][0]},
        )


def data_downgrades() -> None:
    """Columns are dropped by schema_downgrades; nothing to reverse."""
