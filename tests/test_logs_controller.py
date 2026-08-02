"""Endpoint tests for /api/v1/logs (tail, files, download)."""
from __future__ import annotations

import json

import pytest
from litestar import Litestar
from litestar.testing import TestClient

from geometrikks.domain.system.controllers.logs import LogsController
from geometrikks.server.routes import create_api_v1_router
from tests.support import ambient_settings_dependency


@pytest.fixture()
def client(tmp_path, monkeypatch):
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    # First line carries raw structlog context keys: the tail endpoint must
    # pass historical log records through unrenamed (see docs/api-conventions.md).
    context_line = json.dumps(
        {"event": "request_finished", "level": "info", "request_id": "abc", "status_code": 200}
    )
    (log_dir / "geometrikks.log").write_text(
        context_line
        + "\n"
        + "\n".join(json.dumps({"event": f"e{i}", "level": "info"}) for i in range(20))
        + "\n",
        encoding="utf-8",
    )
    (log_dir / "login.log").write_text("2026-07-23T00:00:00Z logout user=\"a\" ip=-\n", encoding="utf-8")
    nginx = tmp_path / "access.log"
    nginx.write_text("nginx line\n", encoding="utf-8")
    monkeypatch.setenv("LOG_DIR", str(log_dir))
    monkeypatch.setenv("LOGPARSER_LOG_PATHS", str(nginx))
    from geometrikks.config.settings import get_settings
    get_settings.cache_clear()
    with TestClient(
        app=Litestar(
            route_handlers=[create_api_v1_router([LogsController])],
            dependencies=ambient_settings_dependency(),
        )
    ) as c:
        yield c


class TestTailEndpoint:
    def test_returns_last_lines(self, client):
        resp = client.get("/api/v1/logs/tail", params={"lines": 5})
        assert resp.status_code == 200
        records = resp.json()["records"]
        assert [r["event"] for r in records] == ["e15", "e16", "e17", "e18", "e19"]

    def test_structlog_context_keys_pass_through_unrenamed(self, client):
        """Raw log context is data, not schema: snake_case keys recorded by
        structlog (request_id, status_code, ...) must reach the wire as-is,
        exempt from the camelCase response policy."""
        resp = client.get("/api/v1/logs/tail", params={"lines": 100})
        assert resp.status_code == 200
        (record,) = [r for r in resp.json()["records"] if r["event"] == "request_finished"]
        assert record["request_id"] == "abc"
        assert record["status_code"] == 200

    def test_lines_clamped_to_2000(self, client):
        assert client.get("/api/v1/logs/tail", params={"lines": 999999}).status_code == 200
        assert client.get("/api/v1/logs/tail", params={"lines": 0}).status_code == 200

    def test_source_login_returns_login_records(self, client):
        resp = client.get("/api/v1/logs/tail", params={"source": "login"})
        assert resp.status_code == 200
        records = resp.json()["records"]
        assert len(records) == 1
        assert records[0]["event"] == "logout"
        assert records[0]["logger"] == "geometrikks.auth.login"

    def test_source_bogus_returns_400(self, client):
        resp = client.get("/api/v1/logs/tail", params={"source": "bogus"})
        assert resp.status_code == 400


class TestFilesEndpoint:
    def test_lists_files(self, client):
        resp = client.get("/api/v1/logs/files")
        assert resp.status_code == 200
        files = {(f["kind"], f["name"]) for f in resp.json()["files"]}
        assert ("app", "geometrikks.log") in files
        assert ("login", "login.log") in files
        assert ("nginx", "access.log") in files


class TestRotateEndpoint:
    def test_returns_201_with_rotated_list(self, client):
        resp = client.post("/api/v1/logs/rotate")
        assert resp.status_code == 201
        assert isinstance(resp.json()["rotated"], list)


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
