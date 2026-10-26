"""add auth_sessions

Revision ID: a41d7e6c2b95
Revises: 3f8a6c1d9b72
Create Date: 2026-10-25 00:00:00.000000

Login sessions and their fingerprints, one row per (key, namespace). The
column set is the one advanced-alchemy's StoreModelMixin declares.
"""

import warnings

from alembic import op

revision = "a41d7e6c2b95"
down_revision = "3f8a6c1d9b72"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute(
                """
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    id UUID NOT NULL,
                    key VARCHAR(255) NOT NULL,
                    namespace VARCHAR(255) NOT NULL,
                    value BYTEA NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    sa_orm_sentinel INTEGER,
                    CONSTRAINT pk_auth_sessions PRIMARY KEY (id),
                    CONSTRAINT uq_auth_sessions_key_namespace UNIQUE (key, namespace)
                )
                """
            )
            op.execute("CREATE INDEX IF NOT EXISTS ix_auth_sessions_expires_at ON auth_sessions (expires_at)")


def downgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute("DROP TABLE IF EXISTS auth_sessions")
