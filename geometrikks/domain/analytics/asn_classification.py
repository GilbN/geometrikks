"""Read-time ASN categorization: hosting/datacenter vs everything else.

Classification is deliberately not stored per row: keyed by ASN it applies
retroactively when the vendored list improves, and the analytics queries
already group by ASN so the lookup cost is trivial. The dataset is the
MIT-licensed brianhama/bad-asn-list (see data/README.md for provenance),
refreshed manually when this feature is touched. Unlisted ASNs read as
"other", never "residential": absence from a hosting list proves nothing.
"""
from __future__ import annotations

import csv
import html
from functools import lru_cache
from pathlib import Path
from typing import Literal

AsnCategory = Literal["datacenter", "other"]

DATASET_NAME = "bad-asn-list"
DATASET_URL = "https://github.com/brianhama/bad-asn-list"
DATASET_LICENSE = "MIT"

_DATA_PATH = Path(__file__).parent / "data" / "hosting_asns.csv"


@lru_cache(maxsize=1)
def hosting_asn_entries() -> tuple[tuple[int, str], ...]:
    """(asn, entity) pairs from the vendored list, deduplicated and sorted.

    Upstream lists a handful of ASNs several times under different entity
    spellings; the first row wins. Entity names are HTML-unescaped because
    a few upstream values are still encoded.
    """
    entries: dict[int, str] = {}
    with _DATA_PATH.open(newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            if not row:
                continue
            try:
                asn = int(row[0].strip().strip('"'))
            except ValueError:
                continue  # header row and any malformed lines
            if asn not in entries:
                entries[asn] = html.unescape(row[1].strip()) if len(row) > 1 else ""
    return tuple(sorted(entries.items()))


@lru_cache(maxsize=1)
def _hosting_asns() -> frozenset[int]:
    return frozenset(asn for asn, _ in hosting_asn_entries())


def classify_asn(asn: int) -> AsnCategory:
    """Category for one autonomous system number."""
    return "datacenter" if asn in _hosting_asns() else "other"


def hosting_asn_count() -> int:
    """Size of the vendored list; used by tests as a load sanity check."""
    return len(_hosting_asns())
