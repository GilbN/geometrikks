"""LogFilesService: listing, allowlisted resolution, JSONL tail."""
from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture()
def service(tmp_path):
    from geometrikks.services.logfiles import LogFilesService
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    (log_dir / "geometrikks.log").write_text(
        "\n".join(json.dumps({"event": f"e{i}", "level": "info"}) for i in range(10)) + "\n",
        encoding="utf-8",
    )
    (log_dir / "geometrikks.log.1.gz").write_bytes(b"\x1f\x8b_fake")
    (log_dir / "login.log").write_text("2026-07-23T00:00:00Z logout user=\"a\" ip=-\n", encoding="utf-8")
    nginx = tmp_path / "access.log"
    nginx.write_text("nginx line\n", encoding="utf-8")
    missing_nginx = tmp_path / "missing" / "other.log"
    return LogFilesService(log_dir=log_dir, nginx_paths=[nginx, missing_nginx])


class TestListFiles:
    def test_lists_all_kinds(self, service):
        entries = {(e.kind, e.name): e for e in service.list_files()}
        assert ("app", "geometrikks.log") in entries
        assert ("app", "geometrikks.log.1.gz") in entries
        assert ("login", "login.log") in entries
        assert ("access", "access.log") in entries

    def test_unreadable_access_marked_unavailable(self, service):
        entries = {e.name: e for e in service.list_files() if e.kind == "access"}
        assert entries["access.log"].available is True
        assert entries["other.log"].available is False


class TestResolve:
    def test_resolves_listed_file(self, service):
        path = service.resolve("app", "geometrikks.log")
        assert path is not None and path.name == "geometrikks.log"

    def test_rejects_traversal_and_unknown(self, service):
        assert service.resolve("app", "../../etc/passwd") is None
        assert service.resolve("app", "passwd") is None
        assert service.resolve("access", "geometrikks.log") is None
        assert service.resolve("bogus", "geometrikks.log") is None

    def test_rejects_unavailable_access_file(self, service):
        assert service.resolve("access", "other.log") is None


class TestTail:
    def test_returns_last_n_parsed_records(self, service):
        records = service.tail_main(lines=3)
        assert [r["event"] for r in records] == ["e7", "e8", "e9"]

    def test_skips_malformed_lines(self, service, tmp_path):
        main = tmp_path / "logs" / "geometrikks.log"
        main.write_text('{"event": "good"}\nnot json\n', encoding="utf-8")
        records = service.tail_main(lines=10)
        assert [r["event"] for r in records] == ["good"]

    def test_missing_file_returns_empty(self, tmp_path):
        from geometrikks.services.logfiles import LogFilesService
        svc = LogFilesService(log_dir=tmp_path / "nope", nginx_paths=[])
        assert svc.tail_main(lines=5) == []


class TestTailLogin:
    def test_parses_valid_lines(self, service):
        records = service.tail_login(lines=10)
        assert len(records) == 1
        record = records[0]
        assert record["timestamp"] == "2026-07-23T00:00:00Z"
        assert record["event"] == "logout"
        assert record["user"] == "a"
        assert record["level"] == "info"
        assert record["logger"] == "geometrikks.auth.login"

    def test_login_failed_gets_warning_level(self, service, tmp_path):
        login = tmp_path / "logs" / "login.log"
        login.write_text(
            '2026-07-23T00:01:00Z login_failed user="bob" ip=1.2.3.4\n', encoding="utf-8"
        )
        records = service.tail_login(lines=10)
        assert records[0]["level"] == "warning"
        assert records[0]["event"] == "login_failed"

    def test_ip_dash_omits_ip_key(self, service):
        records = service.tail_login(lines=10)
        assert "ip" not in records[0]

    def test_ip_present_when_valid(self, service, tmp_path):
        login = tmp_path / "logs" / "login.log"
        login.write_text(
            '2026-07-23T00:01:00Z login_success user="bob" ip=1.2.3.4\n', encoding="utf-8"
        )
        records = service.tail_login(lines=10)
        assert records[0]["ip"] == "1.2.3.4"

    def test_skips_malformed_lines(self, service, tmp_path):
        login = tmp_path / "logs" / "login.log"
        login.write_text(
            '2026-07-23T00:01:00Z login_success user="ok" ip=-\nnot a valid line\n',
            encoding="utf-8",
        )
        records = service.tail_login(lines=10)
        assert [r["event"] for r in records] == ["login_success"]

    def test_missing_file_returns_empty(self, tmp_path):
        from geometrikks.services.logfiles import LogFilesService
        svc = LogFilesService(log_dir=tmp_path / "nope", nginx_paths=[])
        assert svc.tail_login(lines=5) == []
