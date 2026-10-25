"""Helpers for the app version string: display style, local builds, comparison."""

from __future__ import annotations

from packaging.version import InvalidVersion, Version

LOCAL_BUILD_LABEL = "local build"


def _parse(version: str) -> Version | None:
    try:
        return Version(version)
    except InvalidVersion:
        return None


def is_local_build(version: str) -> bool:
    """True for an empty or "unknown" version and for an all-zero release.

    A checkout with no reachable tag resolves to 0.0.0+local, or to 0.0+g<sha>
    in a tagless shallow clone.
    """
    if version in ("", "unknown"):
        return True
    parsed = _parse(version)
    return parsed is not None and not any(parsed.release)


def display_version(version: str) -> str:
    """Show a PEP 440 version in tag style: 0.22.0.dev4 becomes v0.22.0-dev.4."""
    if is_local_build(version):
        return LOCAL_BUILD_LABEL
    parsed = _parse(version)
    if parsed is None:
        return f"v{version}" if version[:1].isdigit() else version
    if parsed.pre is not None or parsed.post is not None:
        return f"v{parsed}"
    text = "v" + ".".join(str(number) for number in parsed.release)
    if parsed.dev is not None:
        text += f"-dev.{parsed.dev}"
    if parsed.local is not None:
        text += f"+{parsed.local}"
    return text


def same_release(a: str, b: str) -> bool:
    """True when two versions match apart from the +local suffix.

    A local build matches anything, since it carries no release to compare.
    """
    if is_local_build(a) or is_local_build(b):
        return True
    parsed_a, parsed_b = _parse(a), _parse(b)
    if parsed_a is None or parsed_b is None:
        return a == b
    return parsed_a.public == parsed_b.public
