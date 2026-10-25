"""Pick the newest GitHub release that applies to the running build.

Tags look like v0.22.1 (stable) and v0.22.1-dev.1 (dev, marked prerelease on
GitHub). A stable build is only offered stable releases. A dev build is
offered every release, so it hears about the next dev tag and the stable one.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

import msgspec
from packaging.version import InvalidVersion, Version

from geometrikks.lib.versioning import is_local_build

RELEASES_URL = "https://api.github.com/repos/GilbN/geometrikks/releases?per_page=30"
MIN_RELEASE_AGE = timedelta(hours=1)
GITHUB_URL_PREFIX = "https://github.com/"


class ReleaseCheckError(Exception):
    """A failed check. str(error) is the reason that gets logged."""


class ReleaseEntry(msgspec.Struct):
    tag_name: str
    draft: bool
    prerelease: bool
    html_url: str
    published_at: datetime | None = None


@dataclass(frozen=True)
class GithubRelease:
    version: Version
    prerelease: bool
    url: str
    published_at: datetime


def tag_version(tag: str) -> Version | None:
    """Parse a release tag: v0.22.1-dev.1 becomes 0.22.1.dev1."""
    normalized = tag.removeprefix("v").replace("-dev.", ".dev")
    try:
        return Version(normalized)
    except InvalidVersion:
        return None


def parse_releases(body: bytes) -> list[GithubRelease]:
    try:
        release_entries = msgspec.json.decode(body, type=list[ReleaseEntry])
    except (msgspec.DecodeError, msgspec.ValidationError) as error:
        raise ReleaseCheckError("invalid response") from error

    github_releases: list[GithubRelease] = []
    for release_entry in release_entries:
        if release_entry.draft or release_entry.published_at is None:
            continue
        # html_url ends up as an href in the SPA
        if not release_entry.html_url.startswith(GITHUB_URL_PREFIX):
            continue
        version = tag_version(release_entry.tag_name)
        if version is None:
            continue
        github_releases.append(
            GithubRelease(
                version=version,
                prerelease=release_entry.prerelease,
                url=release_entry.html_url,
                published_at=release_entry.published_at,
            )
        )
    return github_releases


def select_newer_release(
    github_releases: Sequence[GithubRelease], running_version: str, now: datetime
) -> GithubRelease | None:
    """The highest settled release above the running build, or None."""
    if is_local_build(running_version):
        return None
    try:
        parsed_running = Version(running_version)
    except InvalidVersion:
        return None

    running_public = Version(parsed_running.public)
    candidates = [
        github_release
        for github_release in github_releases
        if (parsed_running.is_prerelease or not github_release.prerelease)
        and now - github_release.published_at >= MIN_RELEASE_AGE
        and github_release.version > running_public
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda github_release: github_release.version)
