"""Response shapes of the instances API.

Kept apart from schemas.py: the ingestion service imports schemas.py, and
these structs import the health report, which imports ingestion.
"""
from datetime import datetime
from typing import Literal

import msgspec

from geometrikks.domain.instances.schemas import HeartbeatPayload
from geometrikks.domain.system.controllers.health import HealthResponse
from geometrikks.lib.advisories import Advisory


class InstanceServerLocationView(msgspec.Struct, rename="camel", kw_only=True):
    server: str
    latitude: float
    longitude: float
    source: str
    detected_at: datetime | None


class InstanceView(msgspec.Struct, rename="camel", kw_only=True):
    """One instance as the Agents page shows it.

    health is payload.health decoded into the typed report, because the
    payload's own health field is an untyped object in OpenAPI. It is None
    when the stored report does not fit the current HealthResponse.
    """

    instance_name: str
    mode: str
    app_version: str
    schema_revision: str
    boot_id: str
    started_at: datetime
    last_seen: datetime
    is_self: bool
    checking_in: bool
    status: Literal["ok", "warning", "critical"]
    problems: list[Advisory]
    payload: HeartbeatPayload | None
    health: HealthResponse | None
    server_locations: list[InstanceServerLocationView]


class HeadIdentityView(msgspec.Struct, rename="camel", kw_only=True):
    instance_name: str
    app_version: str
    schema_revision: str


class InstancesResponse(msgspec.Struct, rename="camel", kw_only=True):
    head: HeadIdentityView
    instances: list[InstanceView]
    checked_at: datetime
