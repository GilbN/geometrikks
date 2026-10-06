"""The open GeoLite2 readers and their cached lookups, held as one unit."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from geoip2.database import Reader
from geoip2.models import ASN, City

from geometrikks.services.logparser.logparser import (
    make_cached_asn_lookup,
    make_cached_city_lookup,
)


@dataclass(frozen=True, slots=True)
class GeoLookups:
    reader: Reader
    asn_reader: Reader | None
    city: Callable[[str], City | None]
    asn: Callable[[str], ASN | None] | None

    @classmethod
    def build(cls, reader: Reader, asn_reader: Reader | None) -> GeoLookups:
        return cls(
            reader=reader,
            asn_reader=asn_reader,
            city=make_cached_city_lookup(reader),
            asn=make_cached_asn_lookup(asn_reader) if asn_reader is not None else None,
        )
