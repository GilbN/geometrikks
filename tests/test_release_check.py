import json
from datetime import UTC, datetime, timedelta

import pytest
from packaging.version import Version

from geometrikks.services.release_check import (
    GithubRelease,
    ReleaseCheckError,
    parse_releases,
    select_newer_release,
    tag_version,
)

NOW = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)
HOURS_AGO_2 = NOW - timedelta(hours=2)


def make_release(
    tag: str, *, prerelease: bool = False, published_at: datetime = HOURS_AGO_2
) -> GithubRelease:
    version = tag_version(tag)
    assert version is not None
    return GithubRelease(
        version=version,
        prerelease=prerelease,
        url=f"https://github.com/GilbN/geometrikks/releases/tag/{tag}",
        published_at=published_at,
    )


def test_tag_version_normalizes_dev_tags() -> None:
    assert tag_version("v0.22.1-dev.1") == Version("0.22.1.dev1")
    assert tag_version("v0.23.0") == Version("0.23.0")
    assert tag_version("nightly") is None


def test_stable_build_ignores_prereleases() -> None:
    dev_release = make_release("v0.22.1-dev.1", prerelease=True)
    assert select_newer_release([dev_release], "0.22.0", NOW) is None

    stable_release = make_release("v0.22.1")
    selected = select_newer_release([dev_release, stable_release], "0.22.0", NOW)
    assert selected is not None
    assert selected.version == Version("0.22.1")


def test_dev_build_sees_a_newer_dev_prerelease() -> None:
    github_release = make_release("v0.22.1-dev.2", prerelease=True)
    selected = select_newer_release([github_release], "0.22.1.dev1+g1234", NOW)
    assert selected == github_release


def test_dev_build_sees_a_newer_stable_release() -> None:
    github_release = make_release("v0.22.1")
    selected = select_newer_release([github_release], "0.22.1.dev1+g1234", NOW)
    assert selected == github_release


def test_equal_version_is_not_newer() -> None:
    dev_release = make_release("v0.22.1-dev.1", prerelease=True)
    assert select_newer_release([dev_release], "0.22.1.dev1+g1234", NOW) is None
    stable_release = make_release("v0.22.1")
    assert select_newer_release([stable_release], "0.22.1", NOW) is None


@pytest.mark.parametrize("running_version", ["0.0.0+local", "unknown"])
def test_local_build_never_checks(running_version: str) -> None:
    assert select_newer_release([make_release("v0.23.0")], running_version, NOW) is None


def test_unparseable_running_version_selects_nothing() -> None:
    assert select_newer_release([make_release("v0.23.0")], "custom", NOW) is None


def test_release_younger_than_an_hour_does_not_count() -> None:
    older_release = make_release("v0.22.1")
    fresh_release = make_release("v0.23.0", published_at=NOW - timedelta(minutes=59))
    selected = select_newer_release([fresh_release, older_release], "0.22.0", NOW)
    assert selected == older_release

    boundary_release = make_release("v0.23.0", published_at=NOW - timedelta(hours=1))
    selected = select_newer_release([boundary_release, older_release], "0.22.0", NOW)
    assert selected == boundary_release

    settled_release = make_release("v0.23.0", published_at=NOW - timedelta(minutes=61))
    selected = select_newer_release([settled_release, older_release], "0.22.0", NOW)
    assert selected == settled_release


def test_out_of_order_list_picks_the_highest_version() -> None:
    github_releases = [make_release("v0.22.0"), make_release("v0.23.0"), make_release("v0.22.1")]
    selected = select_newer_release(github_releases, "0.21.0", NOW)
    assert selected is not None
    assert selected.version == Version("0.23.0")


def test_parse_skips_drafts_unparseable_tags_and_foreign_urls() -> None:
    def entry(
        tag: str,
        *,
        draft: bool = False,
        url: str | None = None,
        published_at: str | None = "2026-10-25T08:00:00Z",
    ) -> dict:
        return {
            "tag_name": tag,
            "draft": draft,
            "prerelease": False,
            "html_url": url or f"https://github.com/GilbN/geometrikks/releases/tag/{tag}",
            "published_at": published_at,
            "name": tag,
        }

    body = json.dumps(
        [
            entry("v0.24.0", draft=True),
            entry("nightly"),
            entry("v0.23.1", url="https://example.com/x"),
            entry("v0.23.2", published_at=None),
            entry("v0.23.0"),
        ]
    ).encode()

    github_releases = parse_releases(body)

    assert len(github_releases) == 1
    assert github_releases[0].version == Version("0.23.0")
    assert github_releases[0].url == "https://github.com/GilbN/geometrikks/releases/tag/v0.23.0"


@pytest.mark.parametrize("body", [b"not json", b'{"message": "API rate limit exceeded"}'])
def test_parse_rejects_a_body_that_is_not_a_release_list(body: bytes) -> None:
    with pytest.raises(ReleaseCheckError) as error:
        parse_releases(body)
    assert str(error.value) == "invalid response"


def test_parse_skips_a_release_published_without_a_timezone() -> None:
    def entry(tag: str, published_at: str) -> dict:
        return {
            "tag_name": tag,
            "draft": False,
            "prerelease": False,
            "html_url": f"https://github.com/GilbN/geometrikks/releases/tag/{tag}",
            "published_at": published_at,
        }

    body = json.dumps(
        [entry("v0.23.1", "2026-10-25T08:00:00"), entry("v0.23.0", "2026-10-25T08:00:00Z")]
    ).encode()

    github_releases = parse_releases(body)

    assert [github_release.version for github_release in github_releases] == [Version("0.23.0")]
    selected = select_newer_release(github_releases, "0.22.0", NOW)
    assert selected is not None
    assert selected.version == Version("0.23.0")


def test_parse_fails_the_whole_response_when_one_entry_is_malformed() -> None:
    valid_entry = {
        "tag_name": "v0.23.0",
        "draft": False,
        "prerelease": False,
        "html_url": "https://github.com/GilbN/geometrikks/releases/tag/v0.23.0",
        "published_at": "2026-10-25T08:00:00Z",
    }
    missing_tag_entry = {key: value for key, value in valid_entry.items() if key != "tag_name"}

    with pytest.raises(ReleaseCheckError) as error:
        parse_releases(json.dumps([valid_entry, missing_tag_entry]).encode())
    assert str(error.value) == "invalid response"
