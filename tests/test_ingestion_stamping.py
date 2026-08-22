"""Ingestion stamps writer hostname and source format onto AccessLog rows."""
from datetime import datetime, timezone
from typing import Any, cast
import pytest
from unittest.mock import MagicMock

from geometrikks.services.ingestion.service import LogIngestionService
from geometrikks.services.logparser.schemas import ParsedAccessLog, ParsedGeoData, ParsedLogRecord


def _parsed(ts: datetime) -> ParsedAccessLog:
    return ParsedAccessLog(
        timestamp=ts, ip_address="203.0.113.7", remote_user=None, method="GET",
        url="/admin", http_version="HTTP/2.0", status_code=200, bytes_sent=10,
        referrer=None, user_agent=None, request_time=0.1,
        upstream_response_time=None, host="example.com",
        country_code="GB", country_name="United Kingdom", city="London",
    )


def test_to_access_log_model_stamps_hostname_and_format() -> None:
    service = LogIngestionService(
        parsers=[], session_maker=cast("Any", None), geoip_path="unused", hostname="myserver",
    )
    model = service._to_access_log_model(
        _parsed(datetime.now(timezone.utc)), log_format="traefik-json"
    )
    assert model.hostname == "myserver"
    assert model.log_format == "traefik-json"
    assert model.url == "/admin"


def test_to_access_log_model_record_hostname_wins() -> None:
    service = LogIngestionService(
        parsers=[], session_maker=cast("Any", None), geoip_path="unused", hostname="myserver",
    )
    model = service._to_access_log_model(
        _parsed(datetime.now(timezone.utc)), log_format="nginx", hostname="vps-2"
    )
    assert model.hostname == "vps-2"


def test_to_access_log_model_empty_hostname_falls_back() -> None:
    service = LogIngestionService(
        parsers=[], session_maker=cast("Any", None), geoip_path="unused", hostname="myserver",
    )
    model = service._to_access_log_model(
        _parsed(datetime.now(timezone.utc)), log_format="nginx", hostname=None
    )
    assert model.hostname == "myserver"


@pytest.mark.anyio
async def test_process_record_stamps_record_hostname_on_geo_event() -> None:
    service = LogIngestionService(
        parsers=[], session_maker=cast("Any", None), geoip_path="unused", hostname="myserver",
    )
    geo = ParsedGeoData(
        latitude=51.5, longitude=-0.1, geohash="gcpvj0", country_code="GB",
        country_name="United Kingdom", timestamp=datetime.now(timezone.utc),
    )
    record = ParsedLogRecord(
        ip_address="203.0.113.7", geo_data=geo, access_log=None,
        raw_line="raw", hostname="vps-2",
    )
    service._location_cache[geo.geohash] = 42  # skip the DB get-or-create path
    repos = MagicMock()

    await service._process_record(record, repos, {"geo": 0, "log": 0, "debug": 0})

    added = repos.geo_event.session.add.call_args[0][0]
    assert added.hostname == "vps-2"
    assert added.location_id == 42
