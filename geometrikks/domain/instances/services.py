"""Read and remove instances for the Agents page."""
from uuid import uuid4

import msgspec
from litestar import Litestar
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.config.settings import Settings, get_installed_version
from geometrikks.domain.exceptions import DomainConflictError, DomainNotFoundError
from geometrikks.domain.geo.models import ServerLocation
from geometrikks.domain.instances.evaluation import (
    HeadIdentity,
    HeartbeatRow,
    InstanceEvaluation,
    evaluate_instances,
)
from geometrikks.domain.instances.repositories import (
    database_now,
    delete_heartbeat,
    fetch_heartbeats,
)
from geometrikks.domain.instances.views import (
    HeadIdentityView,
    InstanceServerLocationView,
    InstancesResponse,
    InstanceView,
)
from geometrikks.domain.system.controllers.health import HealthResponse
from geometrikks.server import runtime
from geometrikks.server.logging import get_logger
from geometrikks.server.schema_wait import bundled_head_revision, known_revisions
from geometrikks.services.geoip.server_locations import fetch_server_locations

logger = get_logger(__name__)


def head_identity(app: Litestar, settings: Settings) -> HeadIdentity:
    """This process as the evaluator sees it.

    Without a writer there is no boot ID to match a row against, so a fresh
    one stands in and no row counts as self.
    """
    writer = runtime.get_heartbeat_writer(app)
    return HeadIdentity(
        boot_id=writer.boot_id if writer is not None else uuid4(),
        instance_name=settings.resolved_instance_name,
        app_version=get_installed_version(),
        schema_revision=bundled_head_revision(),
        known_revisions=frozenset(known_revisions()),
    )


def _typed_health(health_report: dict) -> HealthResponse | None:
    try:
        return msgspec.convert(health_report, HealthResponse, strict=False)
    except msgspec.ValidationError:
        return None


def _location_view(server_location: ServerLocation) -> InstanceServerLocationView:
    return InstanceServerLocationView(
        server=server_location.server,
        latitude=server_location.latitude,
        longitude=server_location.longitude,
        source=server_location.source,
        detected_at=server_location.detected_at,
    )


def _instance_view(
    evaluation: InstanceEvaluation, locations_by_server: dict[str, ServerLocation]
) -> InstanceView:
    heartbeat_row = evaluation.row
    payload = evaluation.payload
    server_names = list(dict.fromkeys(payload.server_names)) if payload is not None else []
    return InstanceView(
        instance_name=heartbeat_row.instance_name,
        mode=heartbeat_row.mode,
        app_version=heartbeat_row.app_version,
        schema_revision=heartbeat_row.schema_revision,
        boot_id=str(heartbeat_row.boot_id),
        started_at=heartbeat_row.started_at,
        last_seen=heartbeat_row.last_seen,
        is_self=evaluation.is_self,
        checking_in=evaluation.checking_in,
        status=evaluation.status,
        problems=evaluation.problems,
        payload=payload,
        health=_typed_health(payload.health) if payload is not None else None,
        server_locations=[
            _location_view(locations_by_server[server_name])
            for server_name in server_names
            if server_name in locations_by_server
        ],
    )


async def list_instances(session: AsyncSession, head: HeadIdentity) -> InstancesResponse:
    heartbeat_rows = [HeartbeatRow.from_model(model) for model in await fetch_heartbeats(session)]
    checked_at = await database_now(session)
    locations_by_server = {
        server_location.server: server_location for server_location in await fetch_server_locations(session)
    }
    evaluations = evaluate_instances(heartbeat_rows, head, checked_at)
    return InstancesResponse(
        head=HeadIdentityView(
            instance_name=head.instance_name,
            app_version=head.app_version,
            schema_revision=head.schema_revision,
        ),
        instances=[_instance_view(evaluation, locations_by_server) for evaluation in evaluations],
        checked_at=checked_at,
    )


async def remove_instance(
    session: AsyncSession, instance_name: str, head: HeadIdentity, *, actor: str
) -> None:
    """Delete one instance's row; the head cannot remove its own.

    The delete runs first and is rolled back for the head's own row, so a
    check-then-delete race cannot remove it. A live agent comes back at its
    next heartbeat; removal is for instances that were shut down.
    """
    removed = await delete_heartbeat(session, instance_name)
    if removed is None:
        raise DomainNotFoundError(f"No instance named {instance_name!r}")
    if removed.boot_id == head.boot_id:
        await session.rollback()
        raise DomainConflictError("This is the head you are talking to; it cannot be removed")
    last_seen = removed.last_seen
    await session.commit()
    logger.info(
        "agent_removed",
        instance_name=instance_name,
        last_seen=last_seen.isoformat(),
        actor=actor,
    )
