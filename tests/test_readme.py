"""README.md is a short front door that links to geometrikks.dev/docs."""
import itertools
import re
from pathlib import Path

README = Path("README.md").read_text(encoding="utf-8")


def test_readme_is_a_front_door() -> None:
    assert len(README.splitlines()) < 100
    assert "—" not in README
    for target in ("https://geometrikks.dev/docs/", "CHANGELOG.md", "SECURITY.md"):
        assert target in README
    assert "/docs/next/" not in README


def test_readme_local_paths_exist() -> None:
    paths = re.findall(r'(?:src|srcset)="([^"]+)"|\]\((?!https?://|#)([^)\s]+)\)', README)
    for path in filter(None, itertools.chain.from_iterable(paths)):
        assert Path(path.lstrip("/")).exists(), path
