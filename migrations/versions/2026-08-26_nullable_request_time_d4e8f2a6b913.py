"""request_time nullable: absent timings stop being 0.0

Revision ID: d4e8f2a6b913
Revises: c9d2e4f7a815
Create Date: 2026-08-26 00:00:00.000000

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
revision = 'd4e8f2a6b913'
down_revision = 'c9d2e4f7a815'
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
    """Both statements are idempotent, so a rerun after a crash is safe.

    Metadata-only on a compressed hypertable: chunks stay compressed.
    """
    op.execute("ALTER TABLE access_logs ALTER COLUMN request_time DROP NOT NULL")
    op.execute("ALTER TABLE access_logs ALTER COLUMN request_time DROP DEFAULT")


def schema_downgrades() -> None:
    """Restore NOT NULL DEFAULT 0.0 after data_downgrades filled the NULLs."""
    op.execute("ALTER TABLE access_logs ALTER COLUMN request_time SET DEFAULT 0.0")
    op.execute("ALTER TABLE access_logs ALTER COLUMN request_time SET NOT NULL")


def data_upgrades() -> None:
    """No backfill: existing 0.0 placeholders stay. `litestar backfill-timings`
    is the explicit opt-in that rewrites the ones it can identify."""


def data_downgrades() -> None:
    """NULL back to 0.0 so SET NOT NULL succeeds.

    On a compressed hypertable an UPDATE over history trips the tuple
    decompression limit, so compressed chunks are decompressed first, the
    same pattern as the url/referrer swap revision.
    """
    bind = op.get_bind()
    has_timescale = bind.execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')"
    )).scalar()
    is_hypertable = has_timescale and bind.execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM timescaledb_information.hypertables "
        "WHERE hypertable_name = 'access_logs')"
    )).scalar()
    if is_hypertable:
        op.execute(
            "SELECT decompress_chunk(format('%I.%I', chunk_schema, chunk_name)::regclass, true) "
            "FROM timescaledb_information.chunks "
            "WHERE hypertable_name = 'access_logs' AND is_compressed"
        )
    op.execute("UPDATE access_logs SET request_time = 0.0 WHERE request_time IS NULL")
