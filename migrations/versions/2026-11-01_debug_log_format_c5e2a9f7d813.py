"""add log_format to access_log_debug

Revision ID: c5e2a9f7d813
Revises: a41d7e6c2b95
Create Date: 2026-11-01 00:00:00.000000

The parser that read each debug line, so the debug view tags stored keys
with that parser's columns. Existing rows stay NULL. Filling them would
read the compressed access_logs table, and they age out under the debug
retention anyway.
"""

import warnings

from alembic import op

revision = "c5e2a9f7d813"
down_revision = "a41d7e6c2b95"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute("ALTER TABLE access_log_debug ADD COLUMN IF NOT EXISTS log_format VARCHAR(32)")


def downgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute("ALTER TABLE access_log_debug DROP COLUMN IF EXISTS log_format")
