"""Head-side CDN scan: aggregation, hysteresis, failure handling."""
from __future__ import annotations

from typing import Any, cast

import pytest
import structlog

from geometrikks.domain.system.proxy_scan import (
    ScanGroup, ScanProvider, apply_scan_results, get_scan_error,
    get_scan_findings, reset_scan_state, run_proxy_scan,
)


@pytest.fixture(autouse=True)
def _clean_state():
    reset_scan_state()
    yield
    reset_scan_state()


def groups_for(hostname: str, rows: int, cdn_rows: int, fmt="traefik-json") -> ScanGroup:
    return ScanGroup(hostname=hostname, log_format=fmt, rows=rows, cdn_rows=cdn_rows)


def test_empty_before_first_run() -> None:
    assert get_scan_findings() == []


def test_source_over_threshold_produces_finding() -> None:
    apply_scan_results(
        [groups_for("traefik-01", 1000, 940)],
        [ScanProvider("traefik-01", 13335, 900), ScanProvider("traefik-01", 54113, 40)],
    )
    [f] = get_scan_findings()
    assert f.hostname == "traefik-01" and f.kind == "cdn"
    assert f.share == 0.94 and f.lines == 1000
    assert f.provider == "Cloudflare" and f.log_format == "traefik-json"
    assert f.path == ""


def test_provider_sums_across_asns_of_one_name() -> None:
    # 13335 and 209242 are both Cloudflare; together they beat Fastly.
    apply_scan_results(
        [groups_for("web", 1000, 900)],
        [ScanProvider("web", 13335, 300), ScanProvider("web", 209242, 300),
         ScanProvider("web", 54113, 300)],
    )
    assert get_scan_findings()[0].provider == "Cloudflare"


def test_row_floor_and_share_threshold() -> None:
    apply_scan_results([groups_for("small", 499, 499)], [])
    assert get_scan_findings() == [], "499 rows is below the floor"
    apply_scan_results([groups_for("mixed", 1000, 690)], [])
    assert get_scan_findings() == [], "69% is below PEER_SHARE_ON"


def test_modal_format_wins() -> None:
    apply_scan_results(
        [ScanGroup("web", "nginx", 800, 700), ScanGroup("web", "traefik-json", 200, 150)],
        [ScanProvider("web", 13335, 850)],
    )
    [f] = get_scan_findings()
    assert f.log_format == "nginx"
    assert f.lines == 1000 and f.share == 0.85


def test_hysteresis_across_runs_logged_once() -> None:
    with structlog.testing.capture_logs() as logs:
        apply_scan_results([groups_for("web", 1000, 800)], [ScanProvider("web", 13335, 800)])
        apply_scan_results([groups_for("web", 1000, 600)], [ScanProvider("web", 13335, 600)])
        assert len(get_scan_findings()) == 1, "60% is between OFF and ON: stays active"
        apply_scan_results([groups_for("web", 1000, 400)], [ScanProvider("web", 13335, 400)])
        assert get_scan_findings() == []
    detected = [e for e in logs if e["event"] == "proxy_peer_detected"]
    cleared = [e for e in logs if e["event"] == "proxy_peer_cleared"]
    assert len(detected) == 1 and detected[0]["origin"] == "db-scan"
    assert detected[0]["hostname"] == "web" and detected[0]["kind"] == "cdn"
    assert len(cleared) == 1


def test_vanished_source_clears() -> None:
    with structlog.testing.capture_logs() as logs:
        apply_scan_results([groups_for("web", 1000, 800)], [ScanProvider("web", 13335, 800)])
        apply_scan_results([], [])
    assert get_scan_findings() == []
    assert [e["event"] for e in logs] == ["proxy_peer_detected", "proxy_peer_cleared"]


@pytest.mark.anyio
async def test_failed_run_keeps_findings_and_records_the_error() -> None:
    """A down database must not read as "problem resolved": the last good
    findings stay and the failure is exposed for /health."""
    apply_scan_results([groups_for("web", 1000, 800)], [ScanProvider("web", 13335, 800)])
    assert len(get_scan_findings()) == 1

    def broken_factory():
        raise RuntimeError("db down")

    with structlog.testing.capture_logs() as logs:
        await run_proxy_scan(broken_factory, set())
    assert len(get_scan_findings()) == 1
    assert get_scan_error() == "db down"
    assert any(e["event"] == "proxy_scan_failed" for e in logs)

    apply_scan_results(
        [groups_for("web", 1000, 600)],
        [ScanProvider("web", 13335, 600)],
    )
    assert len(get_scan_findings()) == 1, "failed scan must retain active hysteresis state"


@pytest.mark.anyio
async def test_successful_run_clears_the_error(monkeypatch) -> None:
    apply_scan_results(
        [groups_for("old", 1000, 800)],
        [ScanProvider("old", 13335, 800)],
    )
    assert [finding.hostname for finding in get_scan_findings()] == ["old"]

    def broken_factory():
        raise RuntimeError("db down")

    await run_proxy_scan(broken_factory, set())
    assert get_scan_error() == "db down"

    from geometrikks.domain.system import proxy_scan

    async def fake_query(session, exclude):
        return (
            [groups_for("new", 1000, 900)],
            [ScanProvider("new", 13335, 900)],
        )

    monkeypatch.setattr(proxy_scan, "_query_scan_rows", fake_query)

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    with structlog.testing.capture_logs() as logs:
        await run_proxy_scan(cast(Any, lambda: _Session()), set())
    assert get_scan_error() is None
    assert [finding.hostname for finding in get_scan_findings()] == ["new"]
    assert any(e["event"] == "proxy_scan_recovered" for e in logs)


@pytest.mark.anyio
async def test_scheduler_registers_scan_job_on_head_only() -> None:
    from geometrikks.config.settings import Settings
    from geometrikks.server.scheduler import create_scheduler

    settings = Settings()
    factory = cast(Any, object())  # never called at registration time

    scheduler = await create_scheduler(factory, settings, mode="full", app=None)
    assert scheduler.get_job("proxy-peer-scan") is not None
    scheduler2 = await create_scheduler(factory, settings, mode="agent", app=None)
    assert scheduler2.get_job("proxy-peer-scan") is None

    settings.app.proxy_advisory = False
    try:
        scheduler3 = await create_scheduler(factory, settings, mode="full", app=None)
        assert scheduler3.get_job("proxy-peer-scan") is None
    finally:
        settings.app.proxy_advisory = True
