"""Read-time ASN categorization: datacenter/hosting vs everything else.

Classification is deliberately not stored per row: keyed by ASN it applies
retroactively when the vendored list improves, and the analytics queries
already group by ASN so the lookup cost is trivial. The dataset is the
MIT-licensed brianhama/bad-asn-list (see data/hosting_asns.LICENSE),
refreshed manually when this feature is touched. Unlisted ASNs read as
"other", never "residential": absence from a hosting list proves nothing.
"""
from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path
from typing import Literal

AsnCategory = Literal["datacenter", "other"]

_DATA_PATH = Path(__file__).parent / "data" / "hosting_asns.csv"


@lru_cache(maxsize=1)
def _hosting_asns() -> frozenset[int]:
    asns: set[int] = set()
    with _DATA_PATH.open(newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            if not row:
                continue
            try:
                asns.add(int(row[0].strip().strip('"')))
            except ValueError:
                continue  # header row and any malformed lines
    return frozenset(asns)


def classify_asn(asn: int) -> AsnCategory:
    """Category for one autonomous system number."""
    return "datacenter" if asn in _hosting_asns() else "other"


def hosting_asn_count() -> int:
    """Size of the vendored list; used by tests as a load sanity check."""
    return len(_hosting_asns())
