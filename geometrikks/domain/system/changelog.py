"""CHANGELOG.md, parsed for the Settings > Changelog page.

The file follows Keep a Changelog, which is regular enough to parse with a
few line prefixes: ``## [version] - date`` opens a release, ``### Kind``
opens a section, ``- `` opens an entry, an indented ``- `` opens a child of
the current entry, and any other indented line continues the entry or child
before it. Entry text keeps its inline markdown (backticks, bold, links);
the client renders those.

Each release links to the footer reference of the same name
(``[0.12.0]: https://...``), the Keep a Changelog way of pointing at a tag
or compare view.

The file ships outside the package, next to alembic.ini and migrations/,
so it resolves from the process cwd first and the repo checkout second.
Its digest doubles as the "build key" the UI stores to tell whether this
build has changelog entries the user has not read: it changes with every
release, dev tag and local rebuild that added entries.
"""

from __future__ import annotations

import hashlib
import re
from datetime import date
from functools import lru_cache
from pathlib import Path

import msgspec

from geometrikks.server.logging import get_logger

logger = get_logger(__name__)

SECTION_KINDS = ("Added", "Changed", "Deprecated", "Removed", "Fixed", "Security")

_RELEASE_RE = re.compile(r"^## \[(?P<version>[^\]]+)\](?:\s*-\s*(?P<date>\d{4}-\d{2}-\d{2}))?\s*$")
_SECTION_RE = re.compile(r"^### (?P<kind>\S.*?)\s*$")
_ENTRY_RE = re.compile(r"^- (?P<text>.*)$")
_CHILD_RE = re.compile(r"^\s+- (?P<text>.*)$")
_LINK_REF_RE = re.compile(r"^\[(?P<version>[^\]]+)\]:\s*(?P<url>\S+)\s*$")


class ChangelogEntry(msgspec.Struct, rename="camel"):
    text: str
    children: list[str]


class ChangelogSection(msgspec.Struct, rename="camel"):
    kind: str
    entries: list[ChangelogEntry]


class ChangelogRelease(msgspec.Struct, rename="camel"):
    version: str
    date: date | None
    unreleased: bool
    url: str | None
    sections: list[ChangelogSection]


class ChangelogResponse(msgspec.Struct, rename="camel"):
    releases: list[ChangelogRelease]


class Changelog(msgspec.Struct):
    releases: list[ChangelogRelease]
    digest: str | None


def parse_changelog(text: str) -> list[ChangelogRelease]:
    """Releases in file order; text before the first release heading is skipped."""
    releases: list[ChangelogRelease] = []
    urls: dict[str, str] = {}
    section: ChangelogSection | None = None
    entry: ChangelogEntry | None = None
    in_child = False

    for raw in text.splitlines():
        line = raw.rstrip()
        if not line:
            continue
        if m := _LINK_REF_RE.match(line):
            urls[m.group("version")] = m.group("url")
            continue
        if m := _RELEASE_RE.match(line):
            version = m.group("version")
            day = m.group("date")
            releases.append(
                ChangelogRelease(
                    version=version,
                    date=date.fromisoformat(day) if day else None,
                    unreleased=version.lower() == "unreleased",
                    url=None,
                    sections=[],
                )
            )
            section = entry = None
            continue
        if not releases:
            continue
        if m := _SECTION_RE.match(line):
            section = ChangelogSection(kind=m.group("kind"), entries=[])
            releases[-1].sections.append(section)
            entry = None
            continue
        if section is None:
            continue
        if m := _ENTRY_RE.match(line):
            entry = ChangelogEntry(text=m.group("text").strip(), children=[])
            section.entries.append(entry)
            in_child = False
            continue
        if entry is None:
            continue
        if m := _CHILD_RE.match(line):
            entry.children.append(m.group("text").strip())
            in_child = True
            continue
        if line[0].isspace():
            if in_child:
                entry.children[-1] = f"{entry.children[-1]} {line.strip()}"
            else:
                entry.text = f"{entry.text} {line.strip()}"
    for release in releases:
        release.url = urls.get(release.version)
    return releases


def locate_changelog() -> Path | None:
    """The cwd copy (container: /app/CHANGELOG.md) or the repo checkout's."""
    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    for candidate in (Path.cwd() / "CHANGELOG.md", repo_root / "CHANGELOG.md"):
        if candidate.is_file():
            return candidate
    return None


@lru_cache(maxsize=1)
def read_changelog() -> Changelog:
    """Parsed releases plus the file digest, read once per process."""
    path = locate_changelog()
    if path is None:
        logger.warning("changelog_missing")
        return Changelog(releases=[], digest=None)
    text = path.read_text(encoding="utf-8")
    releases = parse_changelog(text)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    logger.info("changelog_loaded", path=str(path), releases=len(releases), digest=digest)
    return Changelog(releases=releases, digest=digest)
