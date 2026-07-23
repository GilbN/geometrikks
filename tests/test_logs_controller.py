"""Endpoint tests for /api/v1/logs (tail, files, download)."""
from __future__ import annotations

import json

import pytest
from litestar import Litestar
from litestar.testing import TestClient

from geometrikks.api.v1.logs_controller import LogsController


@pytest.fixture()
def client(tmp_path, monkeypatch):
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    (log_dir / "geometrikks.log").write_text(
        "\n".join(json.dumps({"event": f"e{i}", "level": "info"}) for i in range(20)) + "\n",
        encoding="utf-8",
    )
    (log_dir / "login.log").write_text("2026-07-23T00:00:00Z logout user=\"a\" ip=-\n", encoding="utf-8")
    nginx = tmp_path / "access.log"
    nginx.write_text("nginx line\n", encoding="utf-8")
    monkeypatch.setenv("LOG_DIR", str(log_dir))
    monkeypatch.setenv("LOGPARSER_LOG_PATHS", str(nginx))
    from geometrikks.config.settings import get_settings
    get_settings.cache_clear()
    with TestClient(app=Litestar(route_handlers=[LogsController])) as c:
        yield c


class TestTailEndpoint:
    def test_returns_last_lines(self, client):
        resp = client.get("/api/v1/logs/tail", params={"lines": 5})
        assert resp.status_code == 200
        records = resp.json()["records"]
        assert [r["event"] for r in records] == ["e15", "e16", "e17", "e18", "e19"]

    def test_lines_clamped_to_2000(self, client):
        assert client.get("/api/v1/logs/tail", params={"lines": 999999}).status_code == 200
        assert client.get("/api/v1/logs/tail", params={"lines": 0}).status_code == 200


class TestFilesEndpoint:
    def test_lists_files(self, client):
        resp = client.get("/api/v1/logs/files")
        assert resp.status_code == 200
        files = {(f["kind"], f["name"]) for f in resp.json()["files"]}
        assert ("app", "geometrikks.log") in files
        assert ("login", "login.log") in files
        assert ("nginx", "access.log") in files


class TestDownloadEndpoint:
    def test_downloads_listed_file(self, client):
        resp = client.get("/api/v1/logs/files/app/geometrikks.log")
        assert resp.status_code == 200
        assert "attachment" in resp.headers.get("content-disposition", "")
        assert b"e19" in resp.content

    def test_unknown_name_404(self, client):
        assert client.get("/api/v1/logs/files/app/nope.log").status_code == 404

    def test_traversal_404(self, client):
        assert client.get("/api/v1/logs/files/app/..%2F..%2Fetc%2Fpasswd").status_code == 404

    def test_kind_mismatch_404(self, client):
        assert client.get("/api/v1/logs/files/nginx/geometrikks.log").status_code == 404
