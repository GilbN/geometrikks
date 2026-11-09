"""The served OpenAPI JSON swaps the fixed example range for the last 24 hours."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from litestar import Litestar, get
from litestar.dto._backend import DTOBackend
from litestar.openapi import OpenAPIConfig
from litestar.openapi.plugins import ScalarRenderPlugin
from litestar.testing import TestClient

from geometrikks.lib.parameters import EXAMPLE_RANGE_END, EXAMPLE_RANGE_START, EndDate, StartDate
from geometrikks.server.openapi_render import LiveRangeExamplesJsonPlugin

FROZEN_NOW = datetime(2027, 3, 9, 14, 37, 52, tzinfo=UTC)


@get("/range")
async def range_handler(start_date: StartDate, end_date: EndDate) -> None:
    return None


def _app() -> Litestar:
    return Litestar(
        [range_handler],
        openapi_config=OpenAPIConfig(
            title="t",
            version="1",
            render_plugins=[ScalarRenderPlugin(), LiveRangeExamplesJsonPlugin(clock=lambda: FROZEN_NOW)],
        ),
    )


def _range_parameters(document: dict) -> dict[str, dict]:
    return {parameter["name"]: parameter for parameter in document["paths"]["/range"]["get"]["parameters"]}


def test_served_schema_shows_the_last_24_hours():
    with TestClient(app=_app()) as client:
        response = client.get("/schema/openapi.json")
    assert response.status_code == 200
    assert EXAMPLE_RANGE_START not in response.text
    assert EXAMPLE_RANGE_END not in response.text
    parameters = _range_parameters(response.json())
    assert parameters["startDate"]["schema"]["examples"] == ["2027-03-08T14:37:00Z"]
    assert parameters["endDate"]["schema"]["examples"] == ["2027-03-09T14:37:00Z"]
    assert "`2027-03-08T14:37:00Z`" in parameters["startDate"]["description"]
    assert "`2027-03-09T14:37:00Z`" in parameters["endDate"]["description"]


def test_a_start_equal_to_the_end_example_is_replaced_once():
    app = Litestar(
        [range_handler],
        openapi_config=OpenAPIConfig(
            title="t",
            version="1",
            render_plugins=[
                ScalarRenderPlugin(),
                LiveRangeExamplesJsonPlugin(clock=lambda: datetime(2026, 11, 3, tzinfo=UTC)),
            ],
        ),
    )
    with TestClient(app=app) as client:
        parameters = _range_parameters(client.get("/schema/openapi.json").json())
    assert parameters["startDate"]["schema"]["examples"] == ["2026-11-02T00:00:00Z"]
    assert parameters["endDate"]["schema"]["examples"] == ["2026-11-03T00:00:00Z"]


def test_the_schema_object_keeps_the_fixed_examples():
    document = _app().openapi_schema.to_schema()
    parameters = _range_parameters(json.loads(json.dumps(document, default=str)))
    assert parameters["startDate"]["schema"]["examples"] == [EXAMPLE_RANGE_START]
    assert parameters["endDate"]["schema"]["examples"] == [EXAMPLE_RANGE_END]


def test_the_scalar_page_still_loads_the_json_route():
    with TestClient(app=_app()) as client:
        page = client.get("/schema")
    assert page.status_code == 200
    assert "/schema/openapi.json" in page.text


def test_create_app_serves_the_live_plugin(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("APP_ADMIN_PASSWORD", "openapi-render-test")
    monkeypatch.setattr(DTOBackend, "_seen_model_names", set())
    from geometrikks.server.core import create_app

    app = create_app()
    assert app.openapi_config is not None
    assert any(isinstance(plugin, LiveRangeExamplesJsonPlugin) for plugin in app.openapi_config.render_plugins)
