"""Unit tests for the structlog pipeline building blocks."""
from __future__ import annotations

import asyncio
import gzip
import json
import logging
import queue
import re
import time
from pathlib import Path
from typing import Any, cast

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
            cast("Any", logger).success("it worked")
        assert caplog.records[0].levelno == SUCCESS_LEVEL
        assert caplog.records[0].getMessage() == "it worked"

    def test_register_is_idempotent(self):
        from geometrikks.server.logging import register_success_level
        register_success_level()
        register_success_level()
        assert logging.getLevelName(25) == "SUCCESS"

    def test_success_works_without_app_configuration(self, caplog):
        # Modules like the importer call logger.success() from scripts and
        # tests that never boot the app; the module-level default must make
        # that safe instead of leaving structlog's success-less default.
        import structlog

        from geometrikks.server.logging import ensure_default_configuration, get_logger
        try:
            structlog.reset_defaults()
            ensure_default_configuration()
            with caplog.at_level(logging.INFO, logger="test.unconfigured"):
                cast("Any", get_logger("test.unconfigured")).success("no app booted")
            assert any(r.levelname == "SUCCESS" for r in caplog.records)
        finally:
            structlog.reset_defaults()
            ensure_default_configuration()

    def test_default_configuration_does_not_clobber_explicit_config(self):
        import structlog

        from geometrikks.server.logging import ensure_default_configuration
        try:
            structlog.reset_defaults()
            marker = structlog.testing.LogCapture()
            structlog.configure(processors=[marker])
            ensure_default_configuration()
            assert structlog.get_config()["processors"] == [marker]
        finally:
            structlog.reset_defaults()
            ensure_default_configuration()


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
    assert config.standard_lib_logging_config is not None
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
        listener = queue_handlers[0].listener
        assert listener is not None
        listener_targets = {type(h).__name__ for h in listener.handlers}
        assert {"StreamHandler", "GzipRotatingFileHandler", "BroadcastHandler"} <= listener_targets
        assert (configured_logging / "geometrikks.log").exists()
        assert (configured_logging / "login.log").exists()

    def test_queue_is_bounded(self, configured_logging):
        import logging.handlers as lh
        from geometrikks.server.logging import LOG_QUEUE_MAXSIZE
        root = logging.getLogger()
        handler = next(h for h in root.handlers if isinstance(h, lh.QueueHandler))
        assert cast("queue.Queue[Any]", handler.queue).maxsize == LOG_QUEUE_MAXSIZE

    def test_full_queue_drops_instead_of_blocking_or_raising(self):
        import queue as queue_mod

        from geometrikks.server.logging import NonBlockingQueueHandler
        handler = NonBlockingQueueHandler(queue_mod.Queue(maxsize=1))
        record = logging.LogRecord("t", logging.INFO, __file__, 1, "one", None, None)
        handler.emit(record)
        handler.emit(record)  # queue full: must return immediately, no error
        assert cast("queue.Queue[Any]", handler.queue).qsize() == 1

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
        cast("Any", structlog.stdlib.get_logger("geometrikks.test")).success("it_worked")
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
        # Use a non-login logger for this probe: the login logger is pinned
        # at INFO (see TestLoginLoggerLevelPinned), so a DEBUG call on it
        # would be filtered at the logger itself rather than demonstrate
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

        # A DEBUG call directly on the login logger, however, is filtered at
        # the logger itself (pinned to INFO), so it must reach neither file
        # at all -- this pins both the login-logger level pin and the
        # per-handler level path in one assertion.
        structlog.stdlib.get_logger(LOGIN_LOGGER_NAME).debug(
            "debug_login_event_should_not_appear", user="x", ip="1.2.3.4"
        )
        time.sleep(0.2)
        assert "debug_login_event_should_not_appear" not in login.read_text(encoding="utf-8")
        assert "debug_login_event_should_not_appear" not in main.read_text(encoding="utf-8")


class TestRotateLogFiles:
    def test_rotates_main_log_and_keeps_logging_working(self, configured_logging):
        import structlog
        from geometrikks.server.logging import rotate_log_files

        structlog.stdlib.get_logger("geometrikks.test.rotate").info("before_rotate")
        main = configured_logging / "geometrikks.log"
        assert _wait_for(lambda: "before_rotate" in main.read_text(encoding="utf-8"))

        rotated = rotate_log_files()
        assert "geometrikks.log" in rotated
        assert (configured_logging / "geometrikks.log.1.gz").exists()
        assert "before_rotate" not in main.read_text(encoding="utf-8")

        structlog.stdlib.get_logger("geometrikks.test.rotate").info("after_rotate")
        assert _wait_for(lambda: "after_rotate" in main.read_text(encoding="utf-8"))

    def test_skips_empty_files(self, configured_logging):
        from geometrikks.server.logging import rotate_log_files

        # login.log exists but is empty until something logs to it.
        login = configured_logging / "login.log"
        assert login.exists()
        assert login.stat().st_size == 0

        rotated = rotate_log_files()
        assert "login.log" not in rotated
        assert not (configured_logging / "login.log.1.gz").exists()


class TestExceptionTraceback:
    """A caught exception logged with exc_info=True must survive the queue
    handler with its traceback intact (see _capture_exc_info)."""

    def test_jsonl_main_log_carries_exception_traceback(self, configured_logging):
        import json as jsonlib
        import structlog
        logger = structlog.stdlib.get_logger("geometrikks.test.exc")
        try:
            raise ValueError("boom for jsonl")
        except ValueError:
            logger.error("caught_error_jsonl", exc_info=True)
        main = configured_logging / "geometrikks.log"
        assert _wait_for(lambda: "caught_error_jsonl" in main.read_text(encoding="utf-8"))
        line = [
            l for l in main.read_text(encoding="utf-8").splitlines() if "caught_error_jsonl" in l
        ][0]
        record = jsonlib.loads(line)
        assert "exception" in record
        assert "ValueError" in record["exception"]
        assert "boom for jsonl" in record["exception"]
        assert "Traceback" in record["exception"]
        assert record["error"] == "ValueError: boom for jsonl"

    def test_explicit_error_kwarg_is_not_clobbered(self, configured_logging):
        import json as jsonlib
        import structlog
        logger = structlog.stdlib.get_logger("geometrikks.test.exc")
        try:
            raise ValueError("boom for kwarg")
        except ValueError:
            logger.error("caught_error_kwarg", exc_info=True, error="custom message")
        main = configured_logging / "geometrikks.log"
        assert _wait_for(lambda: "caught_error_kwarg" in main.read_text(encoding="utf-8"))
        line = [
            l for l in main.read_text(encoding="utf-8").splitlines() if "caught_error_kwarg" in l
        ][0]
        record = jsonlib.loads(line)
        assert record["error"] == "custom message"
        assert "Traceback" in record["exception"]

    def test_broadcast_record_carries_exception_traceback(self, configured_logging):
        import structlog
        from geometrikks.server.logging import log_broadcaster

        async def scenario():
            log_broadcaster.bind_loop(asyncio.get_running_loop())
            q = log_broadcaster.subscribe()
            try:
                logger = structlog.stdlib.get_logger("geometrikks.test.exc.broadcast")
                try:
                    raise ValueError("boom for broadcast")
                except ValueError:
                    logger.error("caught_error_broadcast", exc_info=True)

                event = None
                deadline = time.time() + 3.0
                while time.time() < deadline:
                    try:
                        candidate = await asyncio.wait_for(q.get(), timeout=0.5)
                    except asyncio.TimeoutError:
                        continue
                    if candidate.get("event") == "caught_error_broadcast":
                        event = candidate
                        break
                assert event is not None, "expected broadcast event was never published"
                assert "exception" in event
                assert "ValueError" in event["exception"]
                assert "boom for broadcast" in event["exception"]
                assert event["error"] == "ValueError: boom for broadcast"
            finally:
                log_broadcaster.unsubscribe(q)

        asyncio.run(scenario())


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
        assert config.standard_lib_logging_config is not None
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


class TestLitestarLoggerFollowsLogLevel:
    def test_warning_level_silences_litestar_info(self, tmp_path, monkeypatch):
        """LOG_LEVEL=WARNING must silence litestar's INFO HTTP request/response
        records; the litestar logger follows the configured level instead of a
        hardcoded INFO pin (unlike the login logger, which is pinned on purpose)."""
        import logging

        monkeypatch.setenv("LOG_DIR", str(tmp_path / "logs"))
        monkeypatch.setenv("LOG_LEVEL", "WARNING")
        from geometrikks.config.settings import get_settings
        get_settings.cache_clear()
        from geometrikks.server.logging import create_logging_config
        config = create_logging_config(get_settings())
        config.configure()
        assert config.standard_lib_logging_config is not None
        config.standard_lib_logging_config.configure()

        litestar_logger = logging.getLogger("litestar")
        assert litestar_logger.getEffectiveLevel() == logging.WARNING
        assert not litestar_logger.isEnabledFor(logging.INFO)
        assert litestar_logger.isEnabledFor(logging.WARNING)


@pytest.fixture()
def _restore_umask():
    """chmod-based writability tests can leave a directory unreadable for
    pytest's own cleanup; make sure permissions are restored either way."""
    dirs: list[Path] = []
    yield dirs
    for d in dirs:
        d.chmod(0o755)


class TestLogDirWritabilityFallback:
    def test_unwritable_log_dir_disables_file_handlers(self, tmp_path, monkeypatch, capsys, _restore_umask):
        import os
        if os.geteuid() == 0:
            pytest.skip("root bypasses directory permission bits")

        log_dir = tmp_path / "unwritable"
        log_dir.mkdir()
        log_dir.chmod(0o555)
        _restore_umask.append(log_dir)

        monkeypatch.setenv("LOG_DIR", str(log_dir))
        monkeypatch.setenv("LOG_LEVEL", "DEBUG")
        from geometrikks.config.settings import get_settings
        get_settings.cache_clear()
        from geometrikks.server.logging import create_logging_config
        config = create_logging_config(get_settings())
        config.configure()
        assert config.standard_lib_logging_config is not None
        config.standard_lib_logging_config.configure()

        # Loud error printed at configure time, mentioning the path and a fix.
        err = capsys.readouterr().err
        assert str(log_dir) in err
        assert "DISABLED" in err
        assert "chown" in err

        # No file handlers registered; only console/broadcast survive.
        import logging.handlers as lh
        root = logging.getLogger()
        queue_handlers = [h for h in root.handlers if isinstance(h, lh.QueueHandler)]
        assert queue_handlers, "root must still log through the queue handler"
        listener = queue_handlers[0].listener
        assert listener is not None
        listener_types = {type(h).__name__ for h in listener.handlers}
        assert "GzipRotatingFileHandler" not in listener_types
        assert "StreamHandler" in listener_types

        # No log files were created inside the unwritable dir.
        assert not (log_dir / "geometrikks.log").exists()
        assert not (log_dir / "login.log").exists()

        # The app still logs (to console) without raising.
        import structlog
        structlog.stdlib.get_logger("geometrikks.test").info("still_alive")

    def test_writable_log_dir_keeps_file_handlers(self, tmp_path, monkeypatch):
        monkeypatch.setenv("LOG_DIR", str(tmp_path / "logs"))
        monkeypatch.setenv("LOG_LEVEL", "DEBUG")
        from geometrikks.config.settings import get_settings
        get_settings.cache_clear()
        from geometrikks.server.logging import create_logging_config
        config = create_logging_config(get_settings())
        config.configure()
        assert config.standard_lib_logging_config is not None
        config.standard_lib_logging_config.configure()

        import logging.handlers as lh
        root = logging.getLogger()
        queue_handlers = [h for h in root.handlers if isinstance(h, lh.QueueHandler)]
        listener = queue_handlers[0].listener
        assert listener is not None
        listener_types = {type(h).__name__ for h in listener.handlers}
        assert "GzipRotatingFileHandler" in listener_types
        assert (tmp_path / "logs" / "geometrikks.log").exists()
        assert (tmp_path / "logs" / "login.log").exists()


class TestAppWiring:
    def test_create_app_configures_structlog_pipeline(self, tmp_path, monkeypatch):
        monkeypatch.setenv("LOG_DIR", str(tmp_path / "applogs"))
        monkeypatch.setenv("APP_AUTH_DISABLED", "true")
        from geometrikks.config.settings import get_settings
        get_settings.cache_clear()
        from geometrikks.server.core import create_app
        create_app()
        assert (tmp_path / "applogs" / "geometrikks.log").exists()


class TestExceptionLoggingHandler:
    """404 and 401 are routine. They get one warning line, not a traceback."""

    class FakeLogger:
        def __init__(self):
            self.warnings: list[tuple[str, dict]] = []
            self.exceptions: list[tuple[str, dict]] = []

        def warning(self, event, **kw):
            self.warnings.append((event, kw))

        def exception(self, event, **kw):
            self.exceptions.append((event, kw))

    def _run(self, exc: Exception, *, debug: bool):
        from geometrikks.server.logging import _exception_logging_handler_factory
        handler = _exception_logging_handler_factory(debug=debug)
        logger = self.FakeLogger()
        scope = {"type": "http", "path": "/api/v1/nope"}
        try:
            raise exc
        except Exception:
            handler(logger, scope, ["Traceback (most recent call last):\n", "boom\n"])
        return logger

    def test_not_found_logs_one_warning_without_traceback(self):
        from litestar.exceptions import NotFoundException
        logger = self._run(NotFoundException(), debug=False)
        assert logger.exceptions == []
        assert len(logger.warnings) == 1
        event, kw = logger.warnings[0]
        assert event == "client_error"
        assert kw["status_code"] == 404
        assert kw["path"] == "/api/v1/nope"
        assert kw["connection_type"] == "http"

    def test_unauthorized_logs_one_warning_without_traceback(self):
        from litestar.exceptions import NotAuthorizedException
        logger = self._run(NotAuthorizedException(), debug=False)
        assert logger.exceptions == []
        assert [e for e, _ in logger.warnings] == ["client_error"]
        assert logger.warnings[0][1]["status_code"] == 401

    def test_server_error_still_logs_a_traceback(self):
        logger = self._run(ValueError("boom"), debug=False)
        assert logger.warnings == []
        assert [e for e, _ in logger.exceptions] == ["Uncaught exception"]

    def test_other_client_errors_still_log_a_traceback(self):
        # 400 usually means a caller is using the API wrong, and the stack
        # says where validation actually failed.
        from litestar.exceptions import ValidationException
        logger = self._run(ValidationException(), debug=False)
        assert logger.warnings == []
        assert [e for e, _ in logger.exceptions] == ["Uncaught exception"]

    def test_debug_mode_keeps_the_traceback_for_client_errors(self):
        from litestar.exceptions import NotFoundException
        logger = self._run(NotFoundException(), debug=True)
        assert logger.warnings == []
        assert [e for e, _ in logger.exceptions] == ["Uncaught exception"]


class TestExceptionLoggingWiring:
    def test_config_installs_our_handler(self, configured_logging):
        from geometrikks.config.settings import get_settings
        from geometrikks.server.logging import create_logging_config
        config = create_logging_config(get_settings())
        assert config.log_exceptions == "always"
        assert config.exception_logging_handler is not None
        assert config.exception_logging_handler.__name__ == "_log_exception"

    @staticmethod
    def _app_with_pipeline():
        """A real app carrying the real logging config, plus routes that
        produce each status we care about."""
        from litestar import Litestar, get
        from litestar.exceptions import NotAuthorizedException
        from geometrikks.config.settings import get_settings
        from geometrikks.server.logging import create_logging_config

        @get("/api/v1/denied")
        async def denied() -> None:
            raise NotAuthorizedException(detail="nope")

        @get("/api/v1/boom")
        async def boom() -> None:
            raise ValueError("a real bug")

        return Litestar(
            route_handlers=[denied, boom],
            logging_config=create_logging_config(get_settings()),
        )

    @staticmethod
    def _records(log_dir, event):
        import json as jsonlib
        text = (log_dir / "geometrikks.log").read_text(encoding="utf-8")
        return [
            jsonlib.loads(line)
            for line in text.splitlines()
            if f'"event": "{event}"' in line or f'"{event}"' in line
        ]

    def test_unmatched_api_path_logs_client_error_not_a_traceback(self, configured_logging):
        """End to end through a real app: a 404 leaves one warning line."""
        from litestar.testing import TestClient

        with TestClient(app=self._app_with_pipeline()) as client:
            assert client.get("/api/v1/nope").status_code == 404

        main = configured_logging / "geometrikks.log"
        assert _wait_for(lambda: "client_error" in main.read_text(encoding="utf-8"))
        text = main.read_text(encoding="utf-8")
        assert "Uncaught exception" not in text
        record = self._records(configured_logging, "client_error")[0]
        assert record["status_code"] == 404
        assert record["path"] == "/api/v1/nope"
        assert "exception" not in record

    def test_anonymous_request_logs_client_error_not_a_traceback(self, configured_logging):
        from litestar.testing import TestClient

        with TestClient(app=self._app_with_pipeline()) as client:
            assert client.get("/api/v1/denied").status_code == 401

        main = configured_logging / "geometrikks.log"
        assert _wait_for(lambda: "client_error" in main.read_text(encoding="utf-8"))
        assert "Uncaught exception" not in main.read_text(encoding="utf-8")
        record = self._records(configured_logging, "client_error")[0]
        assert record["status_code"] == 401
        assert record["path"] == "/api/v1/denied"
        assert "exception" not in record

    def test_server_error_still_logs_a_traceback(self, configured_logging):
        from litestar.testing import TestClient

        with TestClient(app=self._app_with_pipeline(), raise_server_exceptions=False) as client:
            assert client.get("/api/v1/boom").status_code == 500

        main = configured_logging / "geometrikks.log"
        assert _wait_for(lambda: "Uncaught exception" in main.read_text(encoding="utf-8"))
        record = self._records(configured_logging, "Uncaught exception")[0]
        assert "Traceback" in record["exception"]
        assert "a real bug" in record["exception"]

    def test_debug_mode_keeps_tracebacks_for_client_errors(self, tmp_path, monkeypatch):
        from litestar.testing import TestClient
        monkeypatch.setenv("LOG_DIR", str(tmp_path / "debuglogs"))
        monkeypatch.setenv("LOG_LEVEL", "DEBUG")
        monkeypatch.setenv("APP_DEBUG", "true")
        from geometrikks.config.settings import get_settings
        get_settings.cache_clear()
        from geometrikks.server.logging import create_logging_config
        config = create_logging_config(get_settings())
        config.configure()
        assert config.standard_lib_logging_config is not None
        config.standard_lib_logging_config.configure()

        from litestar import Litestar
        app = Litestar(route_handlers=[], logging_config=config, debug=True)
        with TestClient(app=app) as client:
            assert client.get("/api/v1/nope").status_code == 404

        main = tmp_path / "debuglogs" / "geometrikks.log"
        assert _wait_for(lambda: "Uncaught exception" in main.read_text(encoding="utf-8"))
        assert "client_error" not in main.read_text(encoding="utf-8")
