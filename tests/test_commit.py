"""Build commit resolution for the About page."""
from __future__ import annotations

import subprocess
from pathlib import Path

from geometrikks.domain.system.commit import read_commit

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_commit_file_in_cwd_wins(tmp_path):
    (tmp_path / "COMMIT").write_text("0123456789abcdef0123456789abcdef01234567\n", encoding="utf-8")
    assert read_commit(cwd=tmp_path, repo_root=tmp_path) == "0123456789abcdef0123456789abcdef01234567"


def test_empty_commit_file_falls_back_to_the_checkout(tmp_path):
    (tmp_path / "COMMIT").write_text("", encoding="utf-8")
    expected = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, text=True).strip()
    assert read_commit(cwd=tmp_path, repo_root=REPO_ROOT) == expected


def test_no_file_and_no_checkout_is_unknown(tmp_path):
    assert read_commit(cwd=tmp_path, repo_root=tmp_path) is None


def test_garbage_in_the_commit_file_is_unknown(tmp_path):
    (tmp_path / "COMMIT").write_text("not a sha\n", encoding="utf-8")
    assert read_commit(cwd=tmp_path, repo_root=tmp_path) is None
