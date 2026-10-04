"""proxy_scan_job excludes the hostnames this instance tails itself."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

import pytest

from geometrikks.server import runtime, scheduler

pytestmark = pytest.mark.anyio


async def test_proxy_scan_job_excludes_the_source_hostnames(monkeypatch) -> None:
    from geometrikks.domain.system import proxy_scan

    service = SimpleNamespace(
        hostname="localhost",
        hostname_for=lambda log_input: log_input.source.hostname or "localhost",
        inputs=[
            SimpleNamespace(source=SimpleNamespace(hostname="web-01")),
            SimpleNamespace(source=SimpleNamespace(hostname="web-02")),
        ]
    )
    monkeypatch.setattr(runtime, "get_ingestion_service", lambda app: service)
    seen: dict[str, Any] = {}

    async def fake_scan(session_factory, exclude):
        seen["exclude"] = exclude

    monkeypatch.setattr(proxy_scan, "run_proxy_scan", fake_scan)

    await scheduler.proxy_scan_job(cast(Any, None), cast(Any, SimpleNamespace()))

    assert seen["exclude"] == {"web-01", "web-02"}


async def test_proxy_scan_job_excludes_the_service_hostname_for_a_source_without_one(
    monkeypatch,
) -> None:
    from geometrikks.domain.system import proxy_scan

    service = SimpleNamespace(
        hostname="edge",
        hostname_for=lambda log_input: log_input.source.hostname or "edge",
        inputs=[
            SimpleNamespace(source=SimpleNamespace(hostname="")),
            SimpleNamespace(source=SimpleNamespace(hostname="web-02")),
        ],
    )
    monkeypatch.setattr(runtime, "get_ingestion_service", lambda app: service)
    seen: dict[str, Any] = {}

    async def fake_scan(session_factory, exclude):
        seen["exclude"] = exclude

    monkeypatch.setattr(proxy_scan, "run_proxy_scan", fake_scan)

    await scheduler.proxy_scan_job(cast(Any, None), cast(Any, SimpleNamespace()))

    assert seen["exclude"] == {"edge", "web-02"}
