"""add abuseipdb_reports

Revision ID: 9c41e7b2d5a8
Revises: 47b5f6c769ad
Create Date: 2026-11-07 00:00:00.000000

Every report that may have reached AbuseIPDB, with who sent it.
"""

import sqlalchemy as sa
from advanced_alchemy.types import DateTimeUTC
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "9c41e7b2d5a8"
down_revision = "47b5f6c769ad"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "abuseipdb_reports",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("ip_address", postgresql.INET(), nullable=False),
        sa.Column("categories", postgresql.ARRAY(sa.SmallInteger()), nullable=False),
        sa.Column("comment", sa.Text(), nullable=False),
        sa.Column("attack_time", DateTimeUTC(timezone=True), nullable=False),
        sa.Column("reported_at", DateTimeUTC(timezone=True), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("abuse_confidence_score", sa.SmallInteger(), nullable=True),
        sa.Column("reporter_kind", sa.Text(), nullable=False),
        sa.Column("reporter_name", sa.Text(), nullable=True),
        sa.Column("api_key_id", sa.Uuid(), nullable=True),
        sa.Column("sa_orm_sentinel", sa.Integer(), nullable=True),
        sa.CheckConstraint("status IN ('unconfirmed', 'sent')", name="ck_abuseipdb_reports_status"),
        sa.CheckConstraint(
            "reporter_kind IN ('user', 'api_key', 'anonymous')", name="ck_abuseipdb_reports_reporter_kind"
        ),
        sa.ForeignKeyConstraint(
            ["api_key_id"], ["api_keys.id"], name="fk_abuseipdb_reports_api_key_id_api_keys", ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_abuseipdb_reports"),
    )
    op.create_index(
        "ix_abuseipdb_reports_ip_reported_at",
        "abuseipdb_reports",
        ["ip_address", sa.text("reported_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_abuseipdb_reports_ip_reported_at", table_name="abuseipdb_reports")
    op.drop_table("abuseipdb_reports")
