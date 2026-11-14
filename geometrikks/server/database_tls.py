"""Detect PostgreSQL TLS files that the process cannot use."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

TLS_FILE_VARIABLES = ("PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY")


@dataclass(frozen=True)
class UnusableTlsFile:
    variable: str
    path: str
    reason: Literal["missing", "not readable"]


def _unusable_reason(path: str) -> Literal["missing", "not readable"] | None:
    try:
        if not Path(path).is_file():
            return "missing"
    except PermissionError:
        # Until Python 3.14, is_file() raises when a parent directory can't be searched.
        return "not readable"
    except OSError:
        return "missing"
    return None if os.access(path, os.R_OK) else "not readable"


def unusable_tls_files(environ: Mapping[str, str]) -> list[UnusableTlsFile]:
    unusable: list[UnusableTlsFile] = []
    for variable in TLS_FILE_VARIABLES:
        path = environ.get(variable)
        if not path:
            continue
        reason = _unusable_reason(path)
        if reason is not None:
            unusable.append(UnusableTlsFile(variable, path, reason))
    return unusable
