"""Unit tests for the structlog pipeline building blocks."""
from __future__ import annotations

import gzip
import logging
import re
from pathlib import Path


class TestSuccessLevel:
    def test_registered_between_info_and_warning(self):
        from geometrikks.server.logging import SUCCESS_LEVEL, register_success_level
        register_success_level()
        assert logging.INFO < SUCCESS_LEVEL < logging.WARNING
        assert logging.getLevelName(SUCCESS_LEVEL) == "SUCCESS"

    def test_stdlib_logger_gains_success_method(self, caplog):
        from geometrikks.server.logging import SUCCESS_LEVEL, register_success_level
        register_success_level()
        logger = logging.getLogger("test.success")
        with caplog.at_level(SUCCESS_LEVEL, logger="test.success"):
            logger.success("it worked")
        assert caplog.records[0].levelno == SUCCESS_LEVEL
        assert caplog.records[0].getMessage() == "it worked"

    def test_register_is_idempotent(self):
        from geometrikks.server.logging import register_success_level
        register_success_level()
        register_success_level()
        assert logging.getLevelName(25) == "SUCCESS"


class TestGzipRotatingFileHandler:
    def _make_handler(self, tmp_path: Path, max_bytes: int = 200):
        from geometrikks.server.logging import GzipRotatingFileHandler
        return GzipRotatingFileHandler(
            filename=str(tmp_path / "app.log"),
            maxBytes=max_bytes,
            backupCount=2,
            encoding="utf-8",
        )

    def test_rotated_file_is_gzipped(self, tmp_path):
        handler = self._make_handler(tmp_path)
        logger = logging.getLogger("test.rotate")
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        try:
            for i in range(50):
                logger.info("x" * 40 + str(i))
        finally:
            logger.removeHandler(handler)
            handler.close()
        archive = tmp_path / "app.log.1.gz"
        assert archive.exists()
        content = gzip.decompress(archive.read_bytes()).decode("utf-8")
        assert "xxxx" in content
        assert (tmp_path / "app.log").exists()  # active file continues

    def test_backup_count_is_enforced(self, tmp_path):
        handler = self._make_handler(tmp_path)
        logger = logging.getLogger("test.rotate2")
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
        try:
            for i in range(300):
                logger.info("y" * 40 + str(i))
        finally:
            logger.removeHandler(handler)
            handler.close()
        assert (tmp_path / "app.log.1.gz").exists()
        assert (tmp_path / "app.log.2.gz").exists()
        assert not (tmp_path / "app.log.3.gz").exists()


LOGIN_LINE_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z '
    r'(login_success|login_failed|logout) user="(?:[^"\\]|\\.)*" ip=\S+$'
)


class TestLoginLineFormat:
    def test_renders_contract_line(self):
        from geometrikks.server.logging import render_login_line
        line = render_login_line(
            None,
            "warning",
            {
                "timestamp": "2026-07-23T10:15:04.123456Z",
                "level": "warning",
                "event": "login_failed",
                "user": "admin",
                "ip": "203.0.113.7",
            },
        )
        assert line == '2026-07-23T10:15:04Z login_failed user="admin" ip=203.0.113.7'
        assert LOGIN_LINE_RE.match(line)

    def test_missing_ip_renders_dash(self):
        from geometrikks.server.logging import render_login_line
        line = render_login_line(
            None, "info",
            {"timestamp": "2026-07-23T10:15:04Z", "event": "logout", "user": "admin"},
        )
        assert line == '2026-07-23T10:15:04Z logout user="admin" ip=-'
        assert LOGIN_LINE_RE.match(line)

    def test_newline_injection_in_user_is_neutralized(self):
        from geometrikks.server.logging import render_login_line
        line = render_login_line(
            None, "warning",
            {
                "timestamp": "2026-07-23T10:15:04Z",
                "event": "login_failed",
                "user": 'x" ip=6.6.6.6\n2026-07-23T10:15:05Z login_failed user="admin',
                "ip": "203.0.113.7",
            },
        )
        assert "\n" not in line
        assert LOGIN_LINE_RE.match(line), line
        assert line.endswith("ip=203.0.113.7")

    def test_quote_escape_in_user(self):
        from geometrikks.server.logging import render_login_line
        line = render_login_line(
            None, "warning",
            {"timestamp": "2026-07-23T10:15:04Z", "event": "login_failed",
             "user": 'a"b', "ip": "203.0.113.7"},
        )
        assert '\\"' in line and "\n" not in line

    def test_hostile_ip_field_falls_back_to_dash(self):
        from geometrikks.server.logging import render_login_line
        line = render_login_line(
            None, "warning",
            {"timestamp": "2026-07-23T10:15:04Z", "event": "login_failed",
             "user": "admin", "ip": '1.2.3.4 extra"'},
        )
        assert line.endswith("ip=-")


class TestLoginOnlyFilter:
    def test_passes_only_login_logger(self):
        from geometrikks.server.logging import LOGIN_LOGGER_NAME, LoginOnlyFilter
        f = LoginOnlyFilter()
        login = logging.LogRecord(LOGIN_LOGGER_NAME, 20, "", 0, "m", None, None)
        other = logging.LogRecord("geometrikks.server", 20, "", 0, "m", None, None)
        assert f.filter(login) is True
        assert f.filter(other) is False
