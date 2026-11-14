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


def unusable_tls_files(environ: Mapping[str, str]) -> list[UnusableTlsFile]:
    unusable: list[UnusableTlsFile] = []
    for variable in TLS_FILE_VARIABLES:
        path = environ.get(variable)
        if not path:
            continue
        if not Path(path).is_file():
            unusable.append(UnusableTlsFile(variable, path, "missing"))
        elif not os.access(path, os.R_OK):
            unusable.append(UnusableTlsFile(variable, path, "not readable"))
    return unusable
