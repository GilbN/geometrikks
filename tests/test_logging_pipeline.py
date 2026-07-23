"""Unit tests for the structlog pipeline building blocks."""
from __future__ import annotations

import gzip
import logging
import re
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
