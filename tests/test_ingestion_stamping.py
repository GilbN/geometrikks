"""Ingestion stamps writer hostname and source format onto AccessLog rows."""
from datetime import datetime, timezone
from typing import Any, cast

from geometrikks.services.ingestion.service import LogIngestionService
from geometrikks.services.logparser.schemas import ParsedAccessLog


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
