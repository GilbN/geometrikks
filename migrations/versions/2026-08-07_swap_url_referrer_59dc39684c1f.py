"""swap historically crossed url/referrer values

Revision ID: 59dc39684c1f
Revises: b7d41e9c2a30
Create Date: 2026-08-07 00:00:00.000000

Runs in alembic's normal transaction on purpose. The swap UPDATE is its own
inverse, so it MUST commit together with the version stamp: under autocommit
a crash after the swap but before the stamp would rerun the revision on the
next startup and silently swap the data back. The CAGG rebuild that has to
run outside a transaction lives in the follow-up revision 5f1c8a7d24b3,
which is rerun-safe on its own.

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
revision = '59dc39684c1f'
down_revision = 'b7d41e9c2a30'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        schema_upgrades()
        data_upgrades()

def downgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        data_downgrades()
        schema_downgrades()

def schema_upgrades() -> None:
    """No schema changes; data-only migration."""


def schema_downgrades() -> None:
    """No schema changes; data-only migration."""


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
    """Swap the historically crossed url/referrer values.

    Until this revision, the parser stored the Referer header in ``url`` and
    the request path in ``referrer`` (crossed regex group names inherited from
    geoip2influx). Order matters: the debug backfill reads pre-swap
    ``access_logs.referrer`` (= the request path), so it runs first.
    May take minutes on large hypertables.

    The url CAGGs still hold pre-swap values when this returns; revision
    5f1c8a7d24b3 rebuilds them.
    """
    bind = op.get_bind()
    if _timescale_present(bind):
        _decompress_access_logs(bind)

    # 1. access_log_debug.url currently holds Referer values; repoint it at
    #    the request path via the linked access_logs row. MATERIALIZED CTE
    #    shape per the 2026-07-18 migration's plan-shape note.
    op.execute("""
        WITH src AS MATERIALIZED (
            SELECT id, referrer FROM access_logs
            WHERE id IN (
                SELECT access_log_id FROM access_log_debug
                WHERE access_log_id IS NOT NULL
            )
        )
        UPDATE access_log_debug d
        SET url = src.referrer
        FROM src
        WHERE d.access_log_id = src.id
    """)

    # 2. The swap itself; right-hand sides read pre-update values in PostgreSQL.
    op.execute("UPDATE access_logs SET url = referrer, referrer = url")

    # 3. The old regex captured $host with surrounding whitespace.
    op.execute(
        "UPDATE access_logs SET host = btrim(host) "
        "WHERE host IS NOT NULL AND host <> btrim(host)"
    )


def data_downgrades() -> None:
    """Reverse the swap; debug rows revert from the re-linked access_logs.

    The url CAGGs are left holding post-swap values: refreshing them needs
    ``CALL refresh_continuous_aggregate``, which cannot run inside this
    transaction, and running it in the follow-up revision's downgrade would
    happen before this one (alembic downgrades head-first). Rebuild them by
    hand after a downgrade:
    ``CALL refresh_continuous_aggregate('url_daily_stats', NULL, NULL);``
    (same for ``url_hourly_stats``).
    """
    bind = op.get_bind()
    if _timescale_present(bind):
        _decompress_access_logs(bind)
    op.execute("UPDATE access_logs SET url = referrer, referrer = url")
    op.execute("""
        WITH src AS MATERIALIZED (
            SELECT id, url FROM access_logs
            WHERE id IN (
                SELECT access_log_id FROM access_log_debug
                WHERE access_log_id IS NOT NULL
            )
        )
        UPDATE access_log_debug d
        SET url = src.url
        FROM src
        WHERE d.access_log_id = src.id
    """)
