"""Relative analytics ranges through Litestar dependency injection."""

from datetime import UTC, datetime, timedelta

import pytest
from litestar import Litestar, get
from litestar.di import NamedDependency, Provide
from litestar.params import SkipValidation
from litestar.testing import AsyncTestClient

from geometrikks.domain.exceptions import DomainValidationError
from geometrikks.lib.time_ranges import TimeRange, provide_time_range, relative_range
from geometrikks.server.exceptions import EXCEPTION_HANDLERS

pytestmark = pytest.mark.anyio
NOW = datetime(2026, 11, 3, 12, tzinfo=UTC)


@get("/api/v1/range", dependencies={"time_range": Provide(provide_time_range, sync_to_thread=False)})
async def range_handler(time_range: NamedDependency[SkipValidation[TimeRange]]) -> dict[str, datetime]:
    return {"startDate": time_range.start, "endDate": time_range.end}


@pytest.mark.parametrize(("window", "duration"), [("15m", timedelta(minutes=15)), ("24h", timedelta(hours=24)), ("365d", timedelta(days=365))])
def test_relative_window_uses_a_single_end(window, duration):
    assert relative_range(window, now=NOW) == TimeRange(NOW - duration, NOW)


@pytest.mark.parametrize("window", ["", "0m", "-1h", "1.5h", "24H", "1d2h", "366d", "999999d", "9" * 1000 + "d"])
def test_invalid_windows_are_bounded(window):
    with pytest.raises(DomainValidationError) as error:
        relative_range(window, now=NOW)
    assert error.value.code == "invalid_range"


@pytest.mark.parametrize("params", [
    {}, {"startDate": NOW.isoformat()}, {"endDate": NOW.isoformat()},
    {"window": "1d", "startDate": NOW.isoformat()},
    {"window": "1d", "endDate": NOW.isoformat()},
    {"window": "366d"}, {"window": "0h"},
    {"startDate": NOW.isoformat(), "endDate": NOW.isoformat()},
    {"startDate": NOW.isoformat(), "endDate": (NOW - timedelta(hours=1)).isoformat()},
    {"startDate": "2026-11-01T00:00:00", "endDate": NOW.isoformat()},
])
async def test_invalid_range_combinations_return_a_coded_400(params):
    async with AsyncTestClient(app=Litestar([range_handler], exception_handlers=EXCEPTION_HANDLERS)) as client:
        response = await client.get("/api/v1/range", params=params)
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_range"


async def test_explicit_bounds_keep_the_callers_offset():
    params = {"startDate": "2026-11-01T01:00:00+01:00", "endDate": "2026-11-02T01:00:00+01:00"}
    async with AsyncTestClient(app=Litestar([range_handler])) as client:
        response = await client.get("/api/v1/range", params=params)
    assert response.status_code == 200
    assert response.json() == params


async def test_relative_window_echoes_resolved_bounds():
    before = datetime.now(UTC)
    async with AsyncTestClient(app=Litestar([range_handler])) as client:
        response = await client.get("/api/v1/range", params={"window": "24h"})
    after = datetime.now(UTC)
    body = response.json()
    start = datetime.fromisoformat(body["startDate"])
    end = datetime.fromisoformat(body["endDate"])
    assert before <= end <= after
    assert end - start == timedelta(hours=24)


def test_every_analytics_route_documents_both_range_modes():
    from geometrikks.config.settings import Settings
    from geometrikks.server.core import create_app

    schema = create_app(settings=Settings(auth_disabled=True)).openapi_schema.to_schema()
    routes = {path: item["get"] for path, item in schema["paths"].items() if path.startswith("/api/v1/analytics/")}
    assert len(routes) == 12
    for path, operation in routes.items():
        parameters = {param["name"]: param for param in operation["parameters"]}
        for name in ("window", "startDate", "endDate"):
            assert name in parameters, (path, name)
            assert not parameters[name].get("required", False), (path, name)
