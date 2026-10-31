import pytest

from geometrikks.lib.versioning import LOCAL_BUILD_LABEL, display_version, is_local_build, same_release


@pytest.mark.parametrize(
    ("version", "expected"),
    [
        ("0.22.0.dev4", "v0.22.0-dev.4"),
        ("0.22.0", "v0.22.0"),
        ("0.22.0.dev4+g52b67d62c", "v0.22.0-dev.4+g52b67d62c"),
        ("0.22.0+g2d297914e", "v0.22.0+g2d297914e"),
        ("0.0.0+local", LOCAL_BUILD_LABEL),
        ("0.0+g3da2446d9", LOCAL_BUILD_LABEL),
        ("unknown", LOCAL_BUILD_LABEL),
        ("", LOCAL_BUILD_LABEL),
        ("9.9.9-test", "v9.9.9-test"),
    ],
)
def test_display_version(version: str, expected: str) -> None:
    assert display_version(version) == expected


@pytest.mark.parametrize(
    ("version", "expected"),
    [
        ("0.0.0+local", True),
        ("0.0+g3da2446d9", True),
        ("unknown", True),
        ("", True),
        ("0.22.0", False),
        ("0.22.0.dev4+g52b67d62c", False),
        ("9.9.9-test", False),
    ],
)
def test_is_local_build(version: str, expected: bool) -> None:
    assert is_local_build(version) is expected


@pytest.mark.parametrize(
    ("a", "b", "expected"),
    [
        ("0.22.0.dev4", "0.22.0.dev4+g52b67d62c", True),
        ("0.22.0.dev3", "0.22.0.dev4", False),
        ("0.22.0", "0.22.0.dev4", False),
        ("0.0.0+local", "0.22.0", True),
        ("unknown", "0.22.0", True),
        ("9.9.9-test", "9.9.9-test", True),
        ("9.9.9-test", "0.22.0", False),
    ],
)
def test_same_release(a: str, b: str, expected: bool) -> None:
    assert same_release(a, b) is expected
