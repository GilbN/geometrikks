"""The git commit this build came from, for the About page.

Container images carry it in ``/app/COMMIT``, written from the ``GIT_SHA``
build arg next to alembic.ini and CHANGELOG.md (release.yml and ci.yml pass
it; a local ``docker build`` leaves it empty). A source checkout asks git.
"""

from __future__ import annotations

import re
import subprocess
from functools import lru_cache
from pathlib import Path

_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")


def read_commit(*, cwd: Path, repo_root: Path) -> str | None:
    commit_file = cwd / "COMMIT"
    if commit_file.is_file():
        value = commit_file.read_text(encoding="utf-8").strip()
        if value:
            return value if _SHA_RE.match(value) else None
    if not (repo_root / ".git").exists():
        return None
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out if _SHA_RE.match(out) else None


@lru_cache(maxsize=1)
def resolve_commit() -> str | None:
    """Resolved once per process; the build does not change underneath it."""
    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    return read_commit(cwd=Path.cwd(), repo_root=repo_root)
