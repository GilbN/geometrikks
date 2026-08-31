"""Keep a Changelog parser behind /api/v1/system/changelog."""
from __future__ import annotations

import hashlib
from datetime import date
from pathlib import Path

import pytest
from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient

from geometrikks.domain.system import changelog
from geometrikks.domain.system.changelog import (
    SECTION_KINDS,
    locate_changelog,
    parse_changelog,
)
from geometrikks.domain.system.controllers.system import SystemController
from geometrikks.server.routes import create_api_v1_router
from tests.support import ambient_settings_dependency

pytestmark = pytest.mark.anyio

REPO_ROOT = Path(__file__).resolve().parent.parent

SAMPLE = """\
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The map runs on MapLibre GL JS 6.

## [0.12.0] - 2026-08-29

### Added

- IP inspector. Every IP in the app gets an inspect button
  that opens a side panel for that address.
- `litestar backfill-timings` clears the placeholder 0.0 response time.

### Fixed

- The Overview cards formatted seconds as if they were milliseconds.

## [0.4.0] - 2026-07-21

### Added

- CrowdSec integration. Set `CROWDSEC_LAPI_URL` to enable it.
  - Security page: stat cards, the
    decisions table.
  - Map overlay: a "Banned IPs" toggle.
- Something after the nested list.

[Unreleased]: https://github.com/GilbN/geometrikks/compare/v0.12.0...develop
[0.12.0]: https://github.com/GilbN/geometrikks/compare/v0.11.0...v0.12.0
[0.4.0]: https://github.com/GilbN/geometrikks/releases/tag/v0.4.0
"""


def test_parses_release_headings_into_version_and_date():
    releases = parse_changelog(SAMPLE)
    assert [(r.version, r.date, r.unreleased) for r in releases] == [
        ("Unreleased", None, True),
        ("0.12.0", date(2026, 8, 29), False),
        ("0.4.0", date(2026, 7, 21), False),
    ]


def test_groups_entries_under_their_section_kind():
    release = parse_changelog(SAMPLE)[1]
    assert [s.kind for s in release.sections] == ["Added", "Fixed"]
    assert [e.text for e in release.sections[1].entries] == [
        "The Overview cards formatted seconds as if they were milliseconds."
    ]


def test_joins_wrapped_entry_lines_with_a_space():
    release = parse_changelog(SAMPLE)[1]
    assert release.sections[0].entries[0].text == (
        "IP inspector. Every IP in the app gets an inspect button "
        "that opens a side panel for that address."
    )


def test_nested_bullets_become_children_of_the_parent_entry():
    entries = parse_changelog(SAMPLE)[2].sections[0].entries
    assert [e.text for e in entries] == [
        "CrowdSec integration. Set `CROWDSEC_LAPI_URL` to enable it.",
        "Something after the nested list.",
    ]
    assert entries[0].children == [
        "Security page: stat cards, the decisions table.",
        'Map overlay: a "Banned IPs" toggle.',
    ]
    assert entries[1].children == []


def test_release_urls_come_from_the_footer_references():
    releases = parse_changelog(SAMPLE)
    assert [r.url for r in releases] == [
        "https://github.com/GilbN/geometrikks/compare/v0.12.0...develop",
        "https://github.com/GilbN/geometrikks/compare/v0.11.0...v0.12.0",
        "https://github.com/GilbN/geometrikks/releases/tag/v0.4.0",
    ]


def test_release_without_a_footer_reference_has_no_url():
    releases = parse_changelog("## [0.1.0] - 2026-07-12\n\n### Added\n\n- First.\n")
    assert releases[0].url is None


def test_ignores_preamble_and_link_reference_footer():
    releases = parse_changelog(SAMPLE)
    texts = [e.text for r in releases for s in r.sections for e in s.entries]
    assert not any("keepachangelog" in t or "github.com" in t for t in texts)


def test_real_changelog_parses_cleanly():
    releases = parse_changelog((REPO_ROOT / "CHANGELOG.md").read_text(encoding="utf-8"))
    assert releases[0].unreleased is True
    assert len(releases) > 10
    for release in releases[1:]:
        assert release.date is not None, release.version
    for release in releases:
        # Unreleased is empty right after a release is cut.
        assert release.sections or release.unreleased, release.version
        assert release.url and release.url.startswith("https://github.com/"), release.version
        for section in release.sections:
            assert section.kind in SECTION_KINDS, (release.version, section.kind)
            assert section.entries, (release.version, section.kind)


def test_locate_prefers_cwd_then_repo_root(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert locate_changelog() == REPO_ROOT / "CHANGELOG.md"
    (tmp_path / "CHANGELOG.md").write_text("# Changelog\n", encoding="utf-8")
    assert locate_changelog() == tmp_path / "CHANGELOG.md"


def test_read_hashes_the_file_it_loaded(tmp_path, monkeypatch):
    path = tmp_path / "CHANGELOG.md"
    path.write_text(SAMPLE, encoding="utf-8")
    monkeypatch.setattr(changelog, "locate_changelog", lambda: path)
    changelog.read_changelog.cache_clear()
    try:
        loaded = changelog.read_changelog()
        assert len(loaded.releases) == 3
        assert loaded.digest == hashlib.sha256(SAMPLE.encode("utf-8")).hexdigest()[:12]
    finally:
        changelog.read_changelog.cache_clear()


def test_read_is_empty_when_file_is_missing(monkeypatch):
    monkeypatch.setattr(changelog, "locate_changelog", lambda: None)
    changelog.read_changelog.cache_clear()
    try:
        assert changelog.read_changelog() == changelog.Changelog(releases=[], digest=None)
    finally:
        changelog.read_changelog.cache_clear()


class UnreachableEngine:
    """db_engine stand-in for the controller's other handlers; never used here."""

    def connect(self):
        raise RuntimeError("database unavailable")


def make_app() -> Litestar:
    return Litestar(
        route_handlers=[create_api_v1_router([SystemController])],
        dependencies={
            **ambient_settings_dependency(),
            "db_engine": Provide(UnreachableEngine, sync_to_thread=False),
        },
    )


async def test_endpoint_returns_releases_in_file_order(monkeypatch):
    monkeypatch.setattr(
        changelog, "read_changelog", lambda: changelog.Changelog(releases=parse_changelog(SAMPLE), digest="abc123def456")
    )
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/changelog")
    assert resp.status_code == 200
    body = resp.json()
    assert [r["version"] for r in body["releases"]] == ["Unreleased", "0.12.0", "0.4.0"]
    first = body["releases"][1]
    assert first == {
        "version": "0.12.0",
        "date": "2026-08-29",
        "unreleased": False,
        "url": "https://github.com/GilbN/geometrikks/compare/v0.11.0...v0.12.0",
        "sections": [
            {
                "kind": "Added",
                "entries": [
                    {
                        "text": (
                            "IP inspector. Every IP in the app gets an inspect button "
                            "that opens a side panel for that address."
                        ),
                        "children": [],
                    },
                    {
                        "text": "`litestar backfill-timings` clears the placeholder 0.0 response time.",
                        "children": [],
                    },
                ],
            },
            {
                "kind": "Fixed",
                "entries": [
                    {
                        "text": "The Overview cards formatted seconds as if they were milliseconds.",
                        "children": [],
                    }
                ],
            },
        ],
    }


async def test_about_carries_the_changelog_digest(monkeypatch):
    monkeypatch.setenv("GEOIP_DB_PATH", "tests/GeoLite2-City-Test.mmdb")
    monkeypatch.setattr(
        changelog, "read_changelog", lambda: changelog.Changelog(releases=[], digest="abc123def456")
    )
    async with AsyncTestClient(app=make_app()) as client:
        resp = await client.get("/api/v1/system/about")
    assert resp.status_code == 200
    assert resp.json()["app"]["changelogDigest"] == "abc123def456"
