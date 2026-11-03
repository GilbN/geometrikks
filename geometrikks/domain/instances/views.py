"""Response shapes of the instances API.

Kept apart from schemas.py: the ingestion service imports schemas.py, and
these structs import the health report, which imports ingestion.
"""
from datetime import datetime
from typing import Annotated, Literal

import msgspec

from geometrikks.domain.instances.schemas import HeartbeatPayload
from geometrikks.domain.system.controllers.health import HealthResponse
from geometrikks.lib.advisories import Advisory


class InstanceServerLocationView(msgspec.Struct, rename="camel", kw_only=True):
    """Where one server sits on the map."""

    server: str
    latitude: float
    longitude: float
    source: Annotated[
        str,
        msgspec.Meta(
            description="`auto` when an instance detected it from its public IP, `override` when MAP_SERVER_LOCATIONS sets it."
        ),
    ]
    detected_at: Annotated[
        datetime | None, msgspec.Meta(description="When the location was detected. Null for an override.")
    ]


# health is payload.health decoded into the typed report, because the
# payload's own health field is an untyped object in OpenAPI.
class InstanceView(msgspec.Struct, rename="camel", kw_only=True):
    """One instance as the Agents page shows it.

    `payload` is the last heartbeat as the instance sent it, or null when it does not fit the current
    schema. `health` is the health report from that heartbeat in the shape `/health` uses, or null when
    it does not fit that shape.
    """

    instance_name: Annotated[
        str, msgspec.Meta(description="APP_INSTANCE_NAME, or `head` or `agent` when that is unset.")
    ]
    mode: Annotated[str, msgspec.Meta(description="`full` for a head, `agent` for a process that only tails logs.")]
    app_version: str
    schema_revision: Annotated[
        str, msgspec.Meta(description="The newest database migration the instance's build ships.")
    ]
    boot_id: Annotated[str, msgspec.Meta(description="A random id that changes every time the process starts.")]
    started_at: datetime
    last_seen: Annotated[
        datetime, msgspec.Meta(description="When the last heartbeat arrived. Instances send one every 30 seconds.")
    ]
    is_self: Annotated[bool, msgspec.Meta(description="Whether this is the head that answered the request.")]
    checking_in: Annotated[
        bool, msgspec.Meta(description="False when no heartbeat has arrived for over 3 minutes.")
    ]
    status: Annotated[
        Literal["ok", "warning", "critical"],
        msgspec.Meta(description="The worst severity in `problems`, or `ok` when there are none."),
    ]
    problems: Annotated[list[Advisory], msgspec.Meta(description="What is wrong with the instance, critical ones first.")]
    payload: HeartbeatPayload | None
    health: HealthResponse | None
    server_locations: Annotated[
        list[InstanceServerLocationView],
        msgspec.Meta(description="The map locations of the servers this instance records log lines for."),
    ]


class HeadIdentityView(msgspec.Struct, rename="camel", kw_only=True):
    """The head that answered the request."""

    instance_name: str
    app_version: str
    schema_revision: Annotated[str, msgspec.Meta(description="The newest database migration the head's build ships.")]


class InstancesResponse(msgspec.Struct, rename="camel", kw_only=True):
    """Every instance that sends heartbeats."""

    head: HeadIdentityView
    instances: list[InstanceView]
    checked_at: Annotated[
        datetime, msgspec.Meta(description="The database time that `checkingIn` and the problems were judged at.")
    ]
