"""add the AbuseIPDB blacklist tables

Revision ID: b7e3d1f04a26
Revises: 9c41e7b2d5a8
Create Date: 2026-11-08 00:00:00.000000

The blacklisted IPs plus one status row. The scheduled refresh fills them.
"""

import sqlalchemy as sa
from advanced_alchemy.types import DateTimeUTC
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "b7e3d1f04a26"
down_revision = "9c41e7b2d5a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "abuseipdb_blacklist",
        sa.Column("ip_address", postgresql.INET(), nullable=False),
        sa.PrimaryKeyConstraint("ip_address", name="pk_abuseipdb_blacklist"),
    )
    op.create_table(
        "abuseipdb_blacklist_status",
        sa.Column("id", sa.SmallInteger(), autoincrement=False, nullable=False),
        sa.Column("generated_at", DateTimeUTC(timezone=True), nullable=True),
        sa.Column("refreshed_at", DateTimeUTC(timezone=True), nullable=True),
        sa.Column("last_attempt_at", DateTimeUTC(timezone=True), nullable=True),
        sa.CheckConstraint("id = 1", name=op.f("ck_abuseipdb_blacklist_status_single_row")),
        sa.PrimaryKeyConstraint("id", name="pk_abuseipdb_blacklist_status"),
    )


def downgrade() -> None:
    op.drop_table("abuseipdb_blacklist_status")
    op.drop_table("abuseipdb_blacklist")
