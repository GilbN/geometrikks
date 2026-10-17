from geometrikks.domain.instances.models import INSTANCE_HEARTBEAT_COLUMNS, InstanceHeartbeat


def test_heartbeat_columns_are_pinned() -> None:
    """Older instances read this table during a rolling upgrade, so it only
    gains nullable columns. A change to this set must be an addition."""
    model_columns = {column.name for column in InstanceHeartbeat.__table__.columns}
    expected_columns = {
        "id",
        "instance_name",
        "boot_id",
        "mode",
        "app_version",
        "schema_revision",
        "started_at",
        "last_seen",
        "payload",
    }
    assert model_columns == INSTANCE_HEARTBEAT_COLUMNS == expected_columns
