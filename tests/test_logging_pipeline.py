"""Unit tests for the structlog pipeline building blocks."""
from __future__ import annotations

import asyncio
import gzip
import json
import logging
import re
import time
from pathlib import Path

import pytest


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
    r'(login_success|login_failed|logout) user="[^"]*" ip=\S+$'
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

    def test_quotes_are_stripped_from_user(self):
        from geometrikks.server.logging import render_login_line
        line = render_login_line(
            None, "warning",
            {"timestamp": "2026-07-23T10:15:04Z", "event": "login_failed",
             "user": 'a"b', "ip": "203.0.113.7"},
        )
        assert line == '2026-07-23T10:15:04Z login_failed user="ab" ip=203.0.113.7'
        assert "\\" not in line
        assert line.count('"') == 2  # only opening and closing quotes around user field

    def test_hostile_ip_field_falls_back_to_dash(self):
        from geometrikks.server.logging import render_login_line
        # Test IP with space and quote
        line = render_login_line(
            None, "warning",
            {"timestamp": "2026-07-23T10:15:04Z", "event": "login_failed",
             "user": "admin", "ip": '1.2.3.4 extra"'},
        )
        assert line.endswith("ip=-")
        # Test IP with semicolon (invalid)
        line = render_login_line(
            None, "warning",
            {"timestamp": "2026-07-23T10:15:04Z", "event": "login_failed",
             "user": "admin", "ip": '6.6.6.6;x'},
        )
        assert line.endswith("ip=-")
        # Test valid IPv4
        line = render_login_line(
            None, "warning",
            {"timestamp": "2026-07-23T10:15:04Z", "event": "login_failed",
             "user": "admin", "ip": "203.0.113.7"},
        )
        assert line.endswith("ip=203.0.113.7")
        # Test valid IPv6
        line = render_login_line(
            None, "warning",
            {"timestamp": "2026-07-23T10:15:04Z", "event": "login_failed",
             "user": "admin", "ip": "2001:db8::1"},
        )
        assert line.endswith("ip=2001:db8::1")

    def test_forged_field_poc_captures_real_ip(self):
        import re as re_mod
        from geometrikks.server.logging import render_login_line
        line = render_login_line(
            None, "warning",
            {"timestamp": "2026-07-23T10:15:04Z", "event": "login_failed",
             "user": 'x" ip=6.6.6.6 extra', "ip": "203.0.113.7"},
        )
        m = re_mod.search(r'user="([^"]*)" ip=(\S+)$', line)
        assert m and m.group(2) == "203.0.113.7"
        assert LOGIN_LINE_RE.match(line), line


class TestLoginOnlyFilter:
    def test_passes_only_login_logger(self):
        from geometrikks.server.logging import LOGIN_LOGGER_NAME, LoginOnlyFilter
        f = LoginOnlyFilter()
        login = logging.LogRecord(LOGIN_LOGGER_NAME, 20, "", 0, "m", None, None)
        other = logging.LogRecord("geometrikks.server", 20, "", 0, "m", None, None)
        assert f.filter(login) is True
        assert f.filter(other) is False


class TestLogBroadcaster:
    def test_publish_from_thread_reaches_subscriber(self):
        from geometrikks.server.logging import LogBroadcaster

        async def scenario():
            b = LogBroadcaster()
            b.bind_loop(asyncio.get_running_loop())
            q = b.subscribe()
            import threading
            t = threading.Thread(target=b.publish_threadsafe, args=({"event": "hi"},))
            t.start()
            t.join()
            event = await asyncio.wait_for(q.get(), timeout=2)
            assert event == {"event": "hi"}
            b.unsubscribe(q)

        asyncio.run(scenario())

    def test_full_queue_drops_oldest(self):
        from geometrikks.server.logging import LogBroadcaster

        async def scenario():
            b = LogBroadcaster(max_queue=2)
            b.bind_loop(asyncio.get_running_loop())
            q = b.subscribe()
            for i in range(3):
                b._publish({"n": i})
            assert q.qsize() == 2
            first = await q.get()
            assert first == {"n": 1}  # oldest ({"n": 0}) was dropped

        asyncio.run(scenario())

    def test_publish_without_loop_is_noop(self):
        from geometrikks.server.logging import LogBroadcaster
        b = LogBroadcaster()
        b.publish_threadsafe({"event": "ignored"})  # must not raise


class TestBroadcastHandler:
    def test_emit_publishes_formatted_json(self):
        from geometrikks.server.logging import BroadcastHandler, LogBroadcaster

        async def scenario():
            broadcaster = LogBroadcaster()
            broadcaster.bind_loop(asyncio.get_running_loop())
            q = broadcaster.subscribe()
            handler = BroadcastHandler(broadcaster=broadcaster)
            handler.setFormatter(logging.Formatter('{"event": "%(message)s"}'))
            record = logging.LogRecord("t", logging.INFO, "", 0, "hello", None, None)
            handler.emit(record)
            await asyncio.sleep(0)  # let call_soon_threadsafe run
            event = await asyncio.wait_for(q.get(), timeout=2)
            assert event == {"event": "hello"}

        asyncio.run(scenario())


@pytest.fixture()
def configured_logging(tmp_path, monkeypatch):
    """Configure the full pipeline against a temp log dir; returns the dir."""
    monkeypatch.setenv("LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    from geometrikks.config.settings import get_settings
    get_settings.cache_clear()
    from geometrikks.server.logging import create_logging_config
    config = create_logging_config(get_settings())
    config.configure()
    config.standard_lib_logging_config.configure()
    return tmp_path / "logs"


def _wait_for(predicate, timeout: float = 3.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class TestCreateLoggingConfig:
    def test_handler_tree_and_files(self, configured_logging):
        import logging.handlers as lh
        root = logging.getLogger()
        queue_handlers = [h for h in root.handlers if isinstance(h, lh.QueueHandler)]
        assert queue_handlers, "root must log through the queue handler"
        listener_targets = {type(h).__name__ for h in queue_handlers[0].listener.handlers}
        assert {"StreamHandler", "GzipRotatingFileHandler", "BroadcastHandler"} <= listener_targets
        assert (configured_logging / "geometrikks.log").exists()
        assert (configured_logging / "login.log").exists()

    def test_jsonl_main_log_line(self, configured_logging):
        import json as jsonlib
        import structlog
        structlog.stdlib.get_logger("geometrikks.test").info("hello_jsonl", answer=42)
        main = configured_logging / "geometrikks.log"
        assert _wait_for(lambda: "hello_jsonl" in main.read_text(encoding="utf-8"))
        line = [l for l in main.read_text(encoding="utf-8").splitlines() if "hello_jsonl" in l][0]
        record = jsonlib.loads(line)
        assert record["event"] == "hello_jsonl"
        assert record["level"] == "info"
        assert record["logger"] == "geometrikks.test"
        assert record["answer"] == 42
        assert "timestamp" in record

    def test_success_level_renders_in_json(self, configured_logging):
        import json as jsonlib
        import structlog
        structlog.stdlib.get_logger("geometrikks.test").success("it_worked")
        main = configured_logging / "geometrikks.log"
        assert _wait_for(lambda: "it_worked" in main.read_text(encoding="utf-8"))
        line = [l for l in main.read_text(encoding="utf-8").splitlines() if "it_worked" in l][0]
        assert jsonlib.loads(line)["level"] == "success"

    def test_login_logger_reaches_login_file_with_contract_format(self, configured_logging):
        import structlog
        from geometrikks.server.logging import LOGIN_LOGGER_NAME
        structlog.stdlib.get_logger(LOGIN_LOGGER_NAME).warning(
            "login_failed", user="admin", ip="203.0.113.7"
        )
        login = configured_logging / "login.log"
        assert _wait_for(lambda: "login_failed" in login.read_text(encoding="utf-8"))
        line = login.read_text(encoding="utf-8").splitlines()[-1]
        assert LOGIN_LINE_RE.match(line), line
        # And the same event also lands in the main log.
        main = configured_logging / "geometrikks.log"
        assert _wait_for(lambda: "login_failed" in main.read_text(encoding="utf-8"))

    def test_other_loggers_do_not_reach_login_file(self, configured_logging):
        import structlog
        structlog.stdlib.get_logger("geometrikks.other").warning("not_a_login_event")
        main = configured_logging / "geometrikks.log"
        assert _wait_for(lambda: "not_a_login_event" in main.read_text(encoding="utf-8"))
        assert "not_a_login_event" not in (configured_logging / "login.log").read_text(encoding="utf-8")

    def test_handler_levels_are_respected_behind_queue(self, configured_logging):
        import structlog
        from geometrikks.server.logging import LOGIN_LOGGER_NAME
        # Use a non-login logger for the DEBUG event: the login logger is
        # pinned at INFO (see TestLoginLoggerLevelPinned), so a DEBUG call on
        # it would be filtered at the logger itself rather than demonstrate
        # per-handler level filtering behind the shared queue.
        structlog.stdlib.get_logger("geometrikks.test.levels").debug(
            "debug_other_event"
        )
        structlog.stdlib.get_logger(LOGIN_LOGGER_NAME).warning(
            "login_failed", user="x", ip="1.2.3.4"
        )
        login = configured_logging / "login.log"
        assert _wait_for(lambda: "login_failed" in login.read_text(encoding="utf-8"))
        assert "debug_other_event" not in login.read_text(encoding="utf-8")
        # The DEBUG event still reaches the main file (its handler level is DEBUG).
        main = configured_logging / "geometrikks.log"
        assert _wait_for(lambda: "debug_other_event" in main.read_text(encoding="utf-8"))


class TestLoginLoggerLevelPinned:
    def test_login_success_reaches_login_file_when_root_level_is_error(self, tmp_path, monkeypatch):
        """LOG_LEVEL=ERROR must not silence the login feed (CrowdSec/fail2ban)."""
        monkeypatch.setenv("LOG_DIR", str(tmp_path / "logs"))
        monkeypatch.setenv("LOG_LEVEL", "ERROR")
        from geometrikks.config.settings import get_settings
        get_settings.cache_clear()
        from geometrikks.server.logging import create_logging_config
        config = create_logging_config(get_settings())
        config.configure()
        config.standard_lib_logging_config.configure()
        log_dir = tmp_path / "logs"

        import structlog
        from geometrikks.server.logging import LOGIN_LOGGER_NAME
        structlog.stdlib.get_logger(LOGIN_LOGGER_NAME).info(
            "login_success", user="admin", ip="203.0.113.7"
        )
        login = log_dir / "login.log"
        assert _wait_for(lambda: "login_success" in login.read_text(encoding="utf-8"))
        line = login.read_text(encoding="utf-8").splitlines()[-1]
        assert LOGIN_LINE_RE.match(line), line


class TestAppWiring:
    def test_create_app_configures_structlog_pipeline(self, tmp_path, monkeypatch):
        monkeypatch.setenv("LOG_DIR", str(tmp_path / "applogs"))
        monkeypatch.setenv("APP_AUTH_DISABLED", "true")
        from geometrikks.config.settings import get_settings
        get_settings.cache_clear()
        from geometrikks.server.core import create_app
        create_app()
        assert (tmp_path / "applogs" / "geometrikks.log").exists()
