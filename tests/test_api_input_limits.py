"""Page size caps and sort field checks on the paged list endpoints."""
from __future__ import annotations

from typing import Any

import pytest
from advanced_alchemy.filters import FilterTypes, LimitOffset, OrderBy, SearchFilter
from litestar import Litestar, get
from litestar.di import NamedDependency
from litestar.params import SkipValidation
from litestar.testing import AsyncTestClient
from sqlalchemy.orm import class_mapper

from geometrikks.config.settings import DatabaseSettings, Settings
from geometrikks.domain.geo.controllers.events import GEO_EVENT_SORT_FIELDS
from geometrikks.domain.geo.models import GeoEvent
from geometrikks.domain.geo.services import GeoEventService
from geometrikks.domain.logs.controllers.access_logs import ACCESS_LOG_SORT_FIELDS
from geometrikks.domain.logs.models import AccessLog
from geometrikks.domain.logs.services import AccessLogService
from geometrikks.domain.logs.sorting import NullsLastOrderBy
from geometrikks.lib.pagination import (
    MAX_LOG_PAGE_SIZE,
    MAX_PAGE_SIZE,
    limit_offset_provider,
    order_by_provider,
)
from geometrikks.server.core import create_app
from geometrikks.server.exceptions import EXCEPTION_HANDLERS

pytestmark = pytest.mark.anyio


def _helper_app() -> Litestar:
    @get(
        "/rows",
        dependencies={
            "limit_offset": limit_offset_provider(default_size=20, max_size=30),
            "order_by": order_by_provider(fields=("timestamp", "status_code"), default="timestamp"),
        },
    )
    async def rows(
        limit_offset: NamedDependency[SkipValidation[LimitOffset]],
        order_by: NamedDependency[SkipValidation[OrderBy]],
    ) -> dict[str, Any]:
        return {
            "limit": limit_offset.limit,
            "offset": limit_offset.offset,
            "field": order_by.field_name,
            "order": order_by.sort_order,
        }

    return Litestar(route_handlers=[rows], exception_handlers=EXCEPTION_HANDLERS)


async def test_helper_defaults_to_the_first_page_and_the_default_sort():
    async with AsyncTestClient(app=_helper_app()) as client:
        resp = await client.get("/rows")
    assert resp.json() == {"limit": 20, "offset": 0, "field": "timestamp", "order": "desc"}


async def test_helper_takes_the_largest_page_and_an_allowed_field():
    async with AsyncTestClient(app=_helper_app()) as client:
        resp = await client.get(
            "/rows", params={"pageSize": 30, "currentPage": 3, "orderBy": "status_code", "sortOrder": "asc"}
        )
    assert resp.json() == {"limit": 30, "offset": 60, "field": "status_code", "order": "asc"}


async def test_helper_rejects_a_page_over_the_cap():
    async with AsyncTestClient(app=_helper_app()) as client:
        resp = await client.get("/rows", params={"pageSize": 31})
    assert resp.status_code == 400
    assert resp.json()["status_code"] == 400


async def test_helper_rejects_an_unknown_sort_order():
    async with AsyncTestClient(app=_helper_app()) as client:
        resp = await client.get("/rows", params={"sortOrder": "up"})
    assert resp.status_code == 400
    assert resp.json()["status_code"] == 400


async def test_helper_rejects_an_unknown_sort_field():
    async with AsyncTestClient(app=_helper_app()) as client:
        resp = await client.get("/rows", params={"orderBy": "nope"})
    assert resp.status_code == 400
    assert resp.json() == {"status_code": 400, "detail": "Cannot sort by 'nope'", "code": "invalid_request"}


def _hermetic_app() -> Litestar:
    return create_app(
        settings=Settings(auth_disabled=True, database=DatabaseSettings(host="127.0.0.1", port=59999))
    )


@pytest.mark.parametrize("path", ["/api/v1/geo-events/", "/api/v1/access-logs/"])
@pytest.mark.parametrize("field", ["nope", "location", "__table__"])
async def test_unknown_sort_field_is_a_400(path: str, field: str):
    async with AsyncTestClient(app=_hermetic_app()) as client:
        resp = await client.get(path, params={"orderBy": field})
    assert resp.status_code == 400
    assert resp.json() == {"status_code": 400, "detail": f"Cannot sort by {field!r}", "code": "invalid_request"}


@pytest.fixture
def captured_filters(monkeypatch: pytest.MonkeyPatch) -> list[FilterTypes]:
    captured: list[FilterTypes] = []

    async def get_many_and_count(_service: object, *filters: FilterTypes, **_kwargs: object) -> tuple[list, int]:
        captured.extend(filters)
        return [], 0

    monkeypatch.setattr(AccessLogService, "get_many_and_count", get_many_and_count)
    monkeypatch.setattr(GeoEventService, "get_many_and_count", get_many_and_count)
    return captured


async def test_access_logs_pass_the_page_sort_and_search_to_the_service(captured_filters: list[FilterTypes]):
    async with AsyncTestClient(app=_hermetic_app()) as client:
        resp = await client.get(
            "/api/v1/access-logs/",
            params={
                "currentPage": 3,
                "pageSize": MAX_LOG_PAGE_SIZE,
                "orderBy": "request_time",
                "sortOrder": "asc",
                "searchString": "hello",
            },
        )
    assert resp.status_code == 200
    assert LimitOffset(MAX_LOG_PAGE_SIZE, 2 * MAX_LOG_PAGE_SIZE) in captured_filters
    assert NullsLastOrderBy("request_time", "asc") in captured_filters
    assert any(isinstance(f, SearchFilter) and f.value == "hello" for f in captured_filters)


async def test_geo_events_default_to_50_rows_newest_first(captured_filters: list[FilterTypes]):
    async with AsyncTestClient(app=_hermetic_app()) as client:
        resp = await client.get("/api/v1/geo-events/")
    assert resp.status_code == 200
    assert LimitOffset(50, 0) in captured_filters
    assert OrderBy("timestamp", "desc") in captured_filters


@pytest.mark.parametrize(
    ("path", "cap"),
    [
        ("/api/v1/geo-events/", MAX_PAGE_SIZE),
        ("/api/v1/geo-locations/", MAX_PAGE_SIZE),
        ("/api/v1/access-logs/", MAX_LOG_PAGE_SIZE),
        ("/api/v1/access-log-debug/", MAX_LOG_PAGE_SIZE),
    ],
)
async def test_page_over_the_cap_is_a_400(path: str, cap: int):
    async with AsyncTestClient(app=_hermetic_app()) as client:
        resp = await client.get(path, params={"pageSize": cap + 1})
    assert resp.status_code == 400
    assert resp.json()["status_code"] == 400


@pytest.fixture(scope="module")
def list_parameters() -> dict[str, dict[str, dict[str, Any]]]:
    document = _hermetic_app().openapi_schema.to_schema()
    return {
        path: {parameter["name"]: parameter for parameter in document["paths"][path]["get"]["parameters"]}
        for path in (
            "/api/v1/geo-events",
            "/api/v1/geo-locations",
            "/api/v1/access-logs",
            "/api/v1/access-log-debug",
            "/api/v1/crowdsec/decisions",
        )
    }


@pytest.mark.parametrize(
    ("path", "cap", "default"),
    [
        ("/api/v1/geo-events", MAX_PAGE_SIZE, 50),
        ("/api/v1/geo-locations", MAX_PAGE_SIZE, 10),
        ("/api/v1/crowdsec/decisions", MAX_PAGE_SIZE, 10),
        ("/api/v1/access-logs", MAX_LOG_PAGE_SIZE, 50),
        ("/api/v1/access-log-debug", MAX_LOG_PAGE_SIZE, 50),
    ],
)
def test_page_size_cap_and_default_are_in_the_schema(
    list_parameters: dict[str, dict[str, dict[str, Any]]], path: str, cap: int, default: int
):
    page_size = list_parameters[path]["pageSize"]
    assert page_size["schema"]["maximum"] == cap
    assert page_size["schema"]["default"] == default
    assert f"from 1 to {cap}. Defaults to {default}." in page_size["description"]


@pytest.mark.parametrize(
    ("path", "fields"),
    [("/api/v1/geo-events", GEO_EVENT_SORT_FIELDS), ("/api/v1/access-logs", ACCESS_LOG_SORT_FIELDS)],
)
def test_order_by_lists_every_allowed_field(
    list_parameters: dict[str, dict[str, dict[str, Any]]], path: str, fields: tuple[str, ...]
):
    description = list_parameters[path]["orderBy"]["description"]
    assert all(f"`{field}`" in description for field in fields)


@pytest.mark.parametrize(
    ("model", "fields"), [(GeoEvent, GEO_EVENT_SORT_FIELDS), (AccessLog, ACCESS_LOG_SORT_FIELDS)]
)
def test_every_model_column_is_sortable(model: type, fields: tuple[str, ...]):
    assert set(fields) == {column.key for column in class_mapper(model).column_attrs}
