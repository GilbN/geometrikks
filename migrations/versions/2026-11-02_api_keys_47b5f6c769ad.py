"""add api_keys

Revision ID: 47b5f6c769ad
Revises: d7b3e1a94c60
Create Date: 2026-11-02 00:00:00.000000

Named bearer keys for the API. The table holds the SHA-256 of each key, never
the key itself.
"""

import sqlalchemy as sa
from advanced_alchemy.types import DateTimeUTC
from alembic import op

revision = "47b5f6c769ad"
down_revision = "d7b3e1a94c60"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "api_keys",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("scope", sa.String(length=16), nullable=False),
        sa.Column("key_hash", sa.String(length=64), nullable=False),
        sa.Column("display_prefix", sa.String(length=8), nullable=False),
        sa.Column("created_at", DateTimeUTC(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("created_by", sa.String(length=255), nullable=False),
        sa.Column("expires_at", DateTimeUTC(timezone=True), nullable=True),
        sa.Column("last_used_at", DateTimeUTC(timezone=True), nullable=True),
        sa.Column("last_used_ip", sa.String(length=64), nullable=True),
        sa.Column("sa_orm_sentinel", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_api_keys"),
    )
    op.create_index("ix_api_keys_key_hash", "api_keys", ["key_hash"], unique=True)
    op.create_index("ix_api_keys_lower_name", "api_keys", [sa.text("lower(name)")], unique=True)


def downgrade() -> None:
    op.drop_index("ix_api_keys_lower_name", table_name="api_keys")
    op.drop_index("ix_api_keys_key_hash", table_name="api_keys")
    op.drop_table("api_keys")
