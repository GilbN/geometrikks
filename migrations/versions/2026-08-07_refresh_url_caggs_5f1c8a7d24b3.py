"""rebuild the url CAGGs after the url/referrer swap

Revision ID: 5f1c8a7d24b3
Revises: 59dc39684c1f
Create Date: 2026-08-07 00:00:00.000000

Split out of 59dc39684c1f so the data swap commits with its version stamp.
``CALL refresh_continuous_aggregate`` cannot run inside a transaction, and a
full rebuild is rerun-idempotent, so it is safe to leave in an autocommit
block where a crash means the revision simply runs again.

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
revision = '5f1c8a7d24b3'
down_revision = '59dc39684c1f'
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
    """No schema changes; data-only migration."""


def schema_downgrades() -> None:
    """No schema changes; data-only migration."""


def _timescale_present(bind: "Connection") -> bool:
    return bool(bind.execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')"
    )).scalar())


def _refresh_url_caggs(bind: "Connection") -> None:
    """Rebuild the top-URL CAGGs over all time.

    Guard: on first boot alembic runs before server/timescale.py creates
    the CAGGs (and there is no data to fix anyway).
    """
    if not _timescale_present(bind):
        return
    for cagg in ("url_hourly_stats", "url_daily_stats"):
        exists = bind.execute(sa.text(
            "SELECT EXISTS (SELECT 1 FROM timescaledb_information.continuous_aggregates "
            "WHERE view_name = :name)"
        ), {"name": cagg}).scalar()
        if exists:
            op.execute(f"CALL refresh_continuous_aggregate('{cagg}', NULL, NULL)")


def data_upgrades() -> None:
    """Rebuild the url CAGGs, which aggregated the pre-swap Referer values.

    May take minutes on large hypertables. Rerunning is harmless: a full
    refresh recomputes every bucket from the raw rows.
    """
    _refresh_url_caggs(op.get_bind())


def data_downgrades() -> None:
    """Nothing to do: the raw rows are still in post-swap orientation here.

    Alembic downgrades head-first, so 59dc39684c1f (which restores the old
    orientation) has not run yet; refreshing now would materialize the same
    values already in the CAGGs. That revision's docstring documents the
    manual refresh needed after a downgrade.
    """
