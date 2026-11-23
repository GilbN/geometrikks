"""add site_homes

Revision ID: a1c4e7d90b21
Revises: b3fef8968d06
Create Date: 2026-08-16 00:00:00.000000

"""

import warnings

import sqlalchemy as sa
from advanced_alchemy.types import (
    GUID,
    ORA_JSONB,
    Bool,
    DateTimeUTC,
    EncryptedString,
    EncryptedText,
    FernetBackend,
    JsonB,
    OneTimeCode,
    PasswordHash,
    StoredObject,
    TOTPSecret,
)
from advanced_alchemy.types.encrypted_string import PGCryptoBackend
from advanced_alchemy.types.password_hash.argon2 import Argon2Hasher
from advanced_alchemy.types.password_hash.passlib import PasslibHasher
from advanced_alchemy.types.password_hash.pwdlib import PwdlibHasher
from alembic import op
from sqlalchemy import Text  # noqa: F401

__all__ = ("data_downgrades", "data_upgrades", "downgrade", "schema_downgrades", "schema_upgrades", "upgrade")

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
revision = 'a1c4e7d90b21'
down_revision = 'b3fef8968d06'
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
    """Create site_homes, tolerating a partially applied rerun.

    Idempotent because migrations run at startup inside autocommit_block();
    a crash mid-migration leaves the table created but the revision
    unstamped, and a non-idempotent CREATE TABLE would then wedge every boot.

    id/created_at/updated_at match BigIntAuditBase's actual emitted shape
    (verified against `\\d geo_locations`, same base class): a standalone
    owned sequence for id, no DB-side defaults for the audit timestamps
    (advanced-alchemy sets those Python-side only).
    """
    op.execute("CREATE SEQUENCE IF NOT EXISTS site_homes_id_seq")
    op.execute("""
        CREATE TABLE IF NOT EXISTS site_homes (
            id BIGINT NOT NULL DEFAULT nextval('site_homes_id_seq'),
            hostname VARCHAR(255) NOT NULL,
            latitude DOUBLE PRECISION NOT NULL,
            longitude DOUBLE PRECISION NOT NULL,
            source VARCHAR(16) NOT NULL,
            detected_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            CONSTRAINT pk_site_homes PRIMARY KEY (id),
            CONSTRAINT uq_site_homes_hostname UNIQUE (hostname),
            CONSTRAINT ck_site_homes_source CHECK (source IN ('auto', 'override'))
        )
    """)
    op.execute("ALTER SEQUENCE site_homes_id_seq OWNED BY site_homes.id")


def schema_downgrades() -> None:
    op.execute("DROP TABLE IF EXISTS site_homes")
    op.execute("DROP SEQUENCE IF EXISTS site_homes_id_seq")


def data_upgrades() -> None:
    pass


def data_downgrades() -> None:
    pass
