"""add asn columns to access_logs

Revision ID: c9d2e4f7a815
Revises: a1c4e7d90b21
Create Date: 2026-08-18 00:00:00.000000

"""

import warnings

import sqlalchemy as sa
from alembic import op
from advanced_alchemy.types import Bool, EncryptedString, EncryptedText, GUID, JsonB, ORA_JSONB, DateTimeUTC, StoredObject, PasswordHash, FernetBackend, TOTPSecret, OneTimeCode
from advanced_alchemy.types.encrypted_string import PGCryptoBackend
from advanced_alchemy.types.password_hash.argon2 import Argon2Hasher
from advanced_alchemy.types.password_hash.passlib import PasslibHasher
from advanced_alchemy.types.password_hash.pwdlib import PwdlibHasher
from sqlalchemy import Text  # noqa: F401
from sqlalchemy.dialects import postgresql  # noqa: F401

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
revision = 'c9d2e4f7a815'
down_revision = 'a1c4e7d90b21'
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
    """Add the ASN columns, tolerating a partially applied rerun.

    Each statement commits on its own (autocommit block), so a crash before
    alembic stamps the revision leaves the columns in place and reruns this
    on the next startup; plain ADD COLUMN would then fail with DuplicateColumn.
    """
    op.execute("ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS autonomous_system_number BIGINT")
    op.execute("ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS autonomous_system_organization VARCHAR(255)")
    # On an existing install access_logs is a hypertable with months of
    # chunks, and a plain CREATE INDEX holds a write lock on all of them for
    # the whole build, stalling any remote agent mid-insert. Building one
    # chunk per transaction keeps each lock short. The option needs
    # autocommit (this block has it) and is rejected on a plain table, which
    # is what access_logs still is on a fresh install, where hypertable
    # conversion happens after migrations.
    bind = op.get_bind()
    has_timescale = bind.execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')"
    )).scalar()
    is_hypertable = has_timescale and bind.execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM timescaledb_information.hypertables "
        "WHERE hypertable_name = 'access_logs')"
    )).scalar()
    with_clause = " WITH (timescaledb.transaction_per_chunk)" if is_hypertable else ""
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_access_logs_asn "
        f"ON access_logs (autonomous_system_number){with_clause}"
    )


def schema_downgrades() -> None:
    """Drop the ASN columns, and first any CAGG that reads them.

    asn_{hourly,daily}_stats (created by server/timescale.py in a later
    release, not by alembic) select these columns, so DROP COLUMN fails
    while they exist. Dropping them is safe: startup recreates them.
    """
    op.execute("DROP MATERIALIZED VIEW IF EXISTS asn_hourly_stats CASCADE")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS asn_daily_stats CASCADE")
    op.execute("DROP INDEX IF EXISTS ix_access_logs_asn")
    op.execute("ALTER TABLE access_logs DROP COLUMN IF EXISTS autonomous_system_organization")
    op.execute("ALTER TABLE access_logs DROP COLUMN IF EXISTS autonomous_system_number")


def data_upgrades() -> None:
    """No backfill: historical rows stay NULL. `litestar backfill-asn`
    (a later release) is the explicit opt-in for history."""


def data_downgrades() -> None:
    """Columns are dropped by schema_downgrades; nothing to reverse."""
