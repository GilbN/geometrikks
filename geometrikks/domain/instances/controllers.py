"""Instances API: every process that reports a heartbeat, and removal of retired ones."""
from __future__ import annotations

from typing import Annotated

from litestar import Controller, Request, delete, get
from litestar.di import NamedDependency
from litestar.exceptions import ServiceUnavailableException
from litestar.openapi.datastructures import ResponseSpec
from litestar.params import PathParameter, SkipValidation
from litestar.status_codes import HTTP_404_NOT_FOUND, HTTP_409_CONFLICT, HTTP_503_SERVICE_UNAVAILABLE
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.config.settings import Settings
from geometrikks.domain.instances.views import InstancesResponse
from geometrikks.domain.instances import services
from geometrikks.server import runtime
from geometrikks.server.exceptions import ErrorEnvelope

_DATABASE_UNAVAILABLE = ResponseSpec(
    data_container=ErrorEnvelope, description="The app runs without its database."
)


def _require_database(request: Request) -> None:
    if not runtime.is_db_available(request.app, default=True):
        raise ServiceUnavailableException(detail="The database is unavailable.")


class InstanceController(Controller):
    path = "/instances"
    tags = ["Instances"]

    @get(
        "/",
        return_dto=None,
        description=(
            "List the head and every agent that reports a heartbeat, the head first, "
            "with a status and a list of problems for each."
        ),
        responses={HTTP_503_SERVICE_UNAVAILABLE: _DATABASE_UNAVAILABLE},
    )
    async def list_instances(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> InstancesResponse:
        _require_database(request)
        return await services.list_instances(db_session, services.head_identity(request.app, settings))

    @delete(
        "/{instance_name:str}",
        return_dto=None,
        description=(
            "Remove a retired instance from the list. An instance that is still "
            "running reappears at its next heartbeat. The head cannot remove itself."
        ),
        responses={
            HTTP_404_NOT_FOUND: ResponseSpec(
                data_container=ErrorEnvelope, description="No instance has this name."
            ),
            HTTP_409_CONFLICT: ResponseSpec(
                data_container=ErrorEnvelope, description="This is the head you are talking to."
            ),
            HTTP_503_SERVICE_UNAVAILABLE: _DATABASE_UNAVAILABLE,
        },
    )
    async def delete_instance(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        settings: NamedDependency[SkipValidation[Settings]],
        instance_name: Annotated[str, PathParameter(description="Name of the instance to remove")],
    ) -> None:
        _require_database(request)
        user = request.scope.get("user")
        await services.remove_instance(
            db_session,
            instance_name,
            services.head_identity(request.app, settings),
            actor=str(user) if user else "unknown",
        )
