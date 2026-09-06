"""Advisory registry: upsert by id, clear, critical-first ordering."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

from geometrikks.lib.advisories import Advisory, AdvisoryRegistry
from geometrikks.server import runtime


def _adv(id_: str, severity: str = "warning") -> Advisory:
    return Advisory(id=id_, severity=cast("Any", severity), summary=f"{id_} summary")


def test_set_then_snapshot_returns_the_advisory() -> None:
    reg = AdvisoryRegistry()
    reg.set(_adv("a"))
    assert [a.id for a in reg.snapshot()] == ["a"]


def test_set_same_id_replaces_without_duplicating() -> None:
    reg = AdvisoryRegistry()
    reg.set(_adv("a"))
    reg.set(Advisory(id="a", severity="warning", summary="updated"))
    snap = reg.snapshot()
    assert len(snap) == 1 and snap[0].summary == "updated"


def test_clear_returns_whether_it_was_set() -> None:
    reg = AdvisoryRegistry()
    reg.set(_adv("a"))
    assert reg.clear("a") is True
    assert reg.clear("a") is False
    assert reg.snapshot() == []


def test_snapshot_orders_critical_first_then_insertion() -> None:
    reg = AdvisoryRegistry()
    reg.set(_adv("w1"))
    reg.set(_adv("c1", "critical"))
    reg.set(_adv("w2"))
    assert [a.id for a in reg.snapshot()] == ["c1", "w1", "w2"]


def test_runtime_accessor_creates_one_registry_per_app() -> None:
    app = SimpleNamespace(state=SimpleNamespace())
    first = runtime.get_advisories(cast("Any", app))
    first.set(_adv("a"))
    assert runtime.get_advisories(cast("Any", app)) is first
    assert [a.id for a in runtime.get_advisories(cast("Any", app)).snapshot()] == ["a"]
