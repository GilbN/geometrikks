"""DROP lists API: the listed networks and ASNs with the state of each feed."""
from __future__ import annotations

from litestar import Controller, get
from litestar.di import NamedDependency, Provide
from litestar.params import SkipValidation

from geometrikks.config.settings import Settings
from geometrikks.domain.drop.dependencies import provide_drop_snapshot
from geometrikks.domain.drop.schemas import DropListsResponse, build_drop_lists_response
from geometrikks.domain.drop.snapshot import DropSnapshot


class DropController(Controller):
    path = "/drop"
    tags = ["Drop"]

    dependencies = {"drop_snapshot": Provide(provide_drop_snapshot)}

    @get(
        "/lists",
        description="Listed DROP networks and ASNs, with the state of each feed.",
        response_headers={"Cache-Control": "private, max-age=300"},
    )
    async def get_drop_lists(
        self,
        drop_snapshot: NamedDependency[SkipValidation[DropSnapshot]],
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> DropListsResponse:
        return build_drop_lists_response(drop_snapshot, enabled=settings.drop.enabled)
