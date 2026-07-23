"""Unit tests for the structlog pipeline building blocks."""
from __future__ import annotations

import gzip
import logging
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
