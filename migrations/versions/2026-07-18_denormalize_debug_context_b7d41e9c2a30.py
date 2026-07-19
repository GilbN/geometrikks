"""denormalize access-log context onto access_log_debug

Revision ID: b7d41e9c2a30
Revises: 2068e0410f83
Create Date: 2026-07-18 20:00:00.000000

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
revision = 'b7d41e9c2a30'
down_revision = '2068e0410f83'
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
    """schema upgrade migrations go here."""
    op.add_column('access_log_debug', sa.Column('log_timestamp', sa.DateTimeUTC(timezone=True), nullable=True))
    op.add_column('access_log_debug', sa.Column('ip_address', postgresql.INET(), nullable=True))
    op.add_column('access_log_debug', sa.Column('method', sa.String(length=10), nullable=True))
    op.add_column('access_log_debug', sa.Column('url', sa.Text(), nullable=True))
    op.add_column('access_log_debug', sa.Column('host', sa.String(length=255), nullable=True))
    op.add_column('access_log_debug', sa.Column('status_code', sa.SmallInteger(), nullable=True))
    op.add_column('access_log_debug', sa.Column('country_code', sa.String(length=2), nullable=True))
    op.add_column('access_log_debug', sa.Column('country_name', sa.String(length=100), nullable=True))
    op.add_column('access_log_debug', sa.Column('city', sa.String(length=100), nullable=True))
    op.add_column('access_log_debug', sa.Column('user_agent', sa.Text(), nullable=True))
    op.create_index('ix_access_log_debug_ip_address', 'access_log_debug', ['ip_address'], unique=False)
    op.create_index('ix_access_log_debug_country_code', 'access_log_debug', ['country_code'], unique=False)
    op.create_index('ix_access_log_debug_city', 'access_log_debug', ['city'], unique=False)

def schema_downgrades() -> None:
    """schema downgrade migrations go here."""
    op.drop_index('ix_access_log_debug_city', table_name='access_log_debug')
    op.drop_index('ix_access_log_debug_country_code', table_name='access_log_debug')
    op.drop_index('ix_access_log_debug_ip_address', table_name='access_log_debug')
    for column in (
        'user_agent', 'city', 'country_name', 'country_code', 'status_code',
        'host', 'url', 'method', 'ip_address', 'log_timestamp',
    ):
        op.drop_column('access_log_debug', column)

def data_upgrades() -> None:
    """Backfill the denormalized columns from the linked access_logs rows.

    The source rows are pulled through a MATERIALIZED CTE using an
    ``IN (subquery)`` predicate. That shape matters: the planner turns it into
    a single hash-join pass over access_logs (~5s for 10.6k rows). Writing the
    join directly as ``UPDATE ... FROM access_logs a WHERE d.access_log_id =
    a.id`` instead reproduces the pathological nested loop and takes ~50s, and
    ``id = ANY(ARRAY(...))`` is worse still (it compares the whole array
    against every compressed chunk and does not finish inside 240s).

    Idempotent and safe to re-run: it only overwrites from the linked row.
    """
    op.execute(
        """
        WITH src AS MATERIALIZED (
            SELECT id, timestamp, ip_address, method, url, host, status_code,
                   country_code, country_name, city, user_agent
            FROM access_logs
            WHERE id IN (
                SELECT access_log_id FROM access_log_debug
                WHERE access_log_id IS NOT NULL
            )
        )
        UPDATE access_log_debug d
        SET log_timestamp = src.timestamp,
            ip_address    = src.ip_address,
            method        = src.method,
            url           = src.url,
            host          = src.host,
            status_code   = src.status_code,
            country_code  = src.country_code,
            country_name  = src.country_name,
            city          = src.city,
            user_agent    = src.user_agent
        FROM src
        WHERE d.access_log_id = src.id
        """
    )

def data_downgrades() -> None:
    """data downgrade migrations go here."""
