"""The /api/v1/muted-ips routes."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from litestar import Controller, delete, get, post
from litestar.di import NamedDependency, Provide
from litestar.openapi.datastructures import ResponseSpec
from litestar.params import JSONBody, PathParameter
from litestar.status_codes import (
    HTTP_404_NOT_FOUND,
    HTTP_409_CONFLICT,
    HTTP_415_UNSUPPORTED_MEDIA_TYPE,
)

from geometrikks.domain.auth.api_key_controllers import requires_json_body
from geometrikks.domain.muted_ips.dependencies import provide_muted_ip_repository
from geometrikks.domain.muted_ips.models import MutedIp
from geometrikks.domain.muted_ips.repositories import MutedIpRepository
from geometrikks.domain.muted_ips.schemas import CreateMutedIpPayload, MutedIpView
from geometrikks.domain.muted_ips.service import add_muted_ip, remove_muted_ip
from geometrikks.server.exceptions import ErrorEnvelope


def _to_view(muted_ip: MutedIp) -> MutedIpView:
    return MutedIpView(
        id=muted_ip.id, network=str(muted_ip.network), note=muted_ip.note, created_at=muted_ip.created_at
    )


class MutedIpController(Controller):
    path = "/muted-ips"
    tags = ["Muted IPs"]
    dependencies = {"muted_ip_repo": Provide(provide_muted_ip_repository)}

    @get(
        "/",
        summary="List muted IPs",
        description="Returns every muted IP and range, oldest first.",
    )
    async def list_muted_ips(self, muted_ip_repo: NamedDependency[MutedIpRepository]) -> list[MutedIpView]:
        muted_ips = await muted_ip_repo.get_many(order_by=[("created_at", False), ("id", False)])
        return [_to_view(muted_ip) for muted_ip in muted_ips]

    @post(
        "/",
        guards=[requires_json_body],
        summary="Mute an IP or range",
        description=(
            "Adds an IP or CIDR range to the muted list. Stores the network in CIDR form and rejects CIDR "
            "ranges with host bits set. An invalid network or a note over the length limit gets a 400. An "
            "entry already on the list, or a full list, gets a 409. Send the body as `application/json`."
        ),
        responses={
            HTTP_409_CONFLICT: ResponseSpec(
                data_container=ErrorEnvelope,
                description="The network is already muted (`muted_ip_exists`) or the list is full (`muted_ip_list_full`).",
            ),
            HTTP_415_UNSUPPORTED_MEDIA_TYPE: ResponseSpec(
                data_container=ErrorEnvelope, description="The body is not sent as application/json."
            ),
        },
    )
    async def create_muted_ip(
        self, muted_ip_repo: NamedDependency[MutedIpRepository], data: JSONBody[CreateMutedIpPayload]
    ) -> MutedIpView:
        return _to_view(await add_muted_ip(muted_ip_repo, data))

    @delete(
        "/{entry_id:uuid}",
        summary="Unmute an IP or range",
        description="Removes one entry from the muted list.",
        responses={HTTP_404_NOT_FOUND: ResponseSpec(data_container=ErrorEnvelope, description="No entry has this id.")},
    )
    async def delete_muted_ip(
        self,
        muted_ip_repo: NamedDependency[MutedIpRepository],
        entry_id: Annotated[UUID, PathParameter(description="The `id` of the entry, from the list.")],
    ) -> None:
        await remove_muted_ip(muted_ip_repo, entry_id)
