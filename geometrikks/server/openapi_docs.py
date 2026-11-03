"""The API introduction and tag descriptions shown at the top of /schema."""

from __future__ import annotations

from litestar.openapi.spec import Tag

API_INTRO = """\
GeoMetrikks reads your reverse proxy's access logs, looks up where each client IP is, and serves \
the results through this API. The web app uses the same endpoints.

## Authentication

Send an API key in the `Authorization` header:

```bash
curl -H "Authorization: Bearer gmk_..." https://geo.example.com/api/v1/stats
```

Create keys in the web app under Settings > API keys. GeoMetrikks shows a key once, right after \
you create it. A logged-in browser sends its `session` cookie instead, so the requests you try on \
this page work without a key while you are logged in.

Every path under `/api/` and `/ws/` needs a key or a session. `/health`, `/health/ready`, \
`/api/v1/auth/login` and `/api/v1/auth/options` need neither. A server started with \
`APP_AUTH_DISABLED=true` asks for no credentials at all, and you cannot create keys on it.

## Scopes

Every key has one of two scopes.

- **Read** keys can send `GET` and `HEAD` requests and open the WebSocket feeds `/ws/live`, \
`/ws/crowdsec` and `/ws/logs`. Any other method gets a 403.
- **Read/write** keys can also ban and unban IPs, ban DROP networks, run a scheduler job, rotate \
the log files and delete server locations and retired instances.

No key can list, create or revoke keys, log out, call `/api/v1/auth/me` or read \
`/api/v1/auth/oidc/status`. Those endpoints answer every key with a 403 and need a browser session.

## Errors

An error response is a JSON object with the HTTP status and a message:

```json
{"status_code": 404, "detail": "The API key does not exist."}
```

When a parameter fails validation, the 400 response adds an `extra` list that names each bad \
parameter:

```json
{
  "status_code": 400,
  "detail": "Validation failed for GET /api/v1/logs/tail?lines=abc",
  "extra": [{"message": "Expected `int`, got `str`", "key": "lines", "source": "query"}]
}
```

Error keys are snake_case. Successful responses use camelCase keys.

| Status | Meaning |
| --- | --- |
| 400 | A parameter or the body failed validation, for example an IP that does not parse. |
| 401 | The request carries no session and no key, or the key is malformed, unknown, revoked or expired. |
| 403 | A Read key sent a write, a key called an endpoint that needs a browser session, or a \
CrowdSec ban or unban reached a server without CrowdSec machine credentials. |
| 404 | No route or no resource matches. CrowdSec endpoints other than the status also answer 404 \
when the CrowdSec integration is off. |
| 409 | The request conflicts with the current state, for example a key name that is taken. |
| 415 | `POST /api/v1/auth/api-keys` got a body that is not `application/json`. |
| 500 | CrowdSec rejected the configured credentials, or the server hit an unexpected error. |
| 502 | The CrowdSec LAPI or an RDAP registry failed to answer or answered with an error. |
| 503 | The database is unreachable. Checking an API key needs the database, so requests with a key \
get a 503 until it is back. |

## Time ranges

Most analytics endpoints and the abuse report take the range as `startDate` and `endDate`. The geo \
event, geo location, access log, access log debug and CrowdSec banned-location endpoints call it \
`fromTimestamp` and `toTimestamp`. Send them as ISO 8601 with a timezone, such as \
`2026-11-01T00:00:00Z`. GeoMetrikks stores times in UTC and returns them in UTC.

`/api/v1/analytics/time-series`, `/api/v1/analytics/geo-time-series` and \
`/api/v1/geo-events/time-series` use hourly buckets for ranges up to 30 days and daily buckets for \
longer ones, and their `granularity` parameter forces either size. Every response with buckets names \
the size it used in `granularity`. Daily buckets are UTC days unless you pass `tz` with an IANA zone \
such as `Europe/Oslo`.

## Pagination

Paged lists take `currentPage`, counted from 1, and `pageSize`. They answer with `items`, \
`total`, `limit` and `offset`, where `total` counts the matches on every page. \
`/api/v1/crowdsec/drop-networks` calls its page parameter `page`. `/api/v1/crowdsec/alerts` pages \
by cursor, so pass the `nextCursor` of one response as `before` to get the next, older page. \
Top lists take a `limit` instead and have no pages.
"""

API_TAGS: list[Tag] = [
    Tag(
        name="Auth",
        description=(
            "Log in and out of the web app, see who is logged in, and list, create and revoke API keys. "
            "Everything here except login and the login options needs a browser session."
        ),
    ),
    Tag(
        name="Analytics",
        description="Request counts, time series and top lists for a time range, and the profile of one IP.",
    ),
    Tag(
        name="Geo Events",
        description=(
            "One event per logged request whose client IP has a GeoIP location, and the summaries and top "
            "lists the Geo Logs page shows."
        ),
    ),
    Tag(
        name="Geo Locations",
        description=(
            "The places requests come from, as a list and as GeoJSON for the map, plus the locations of your "
            "own servers."
        ),
    ),
    Tag(
        name="Access Logs",
        description="The parsed access log lines with their HTTP fields, filtered, searched and paged.",
    ),
    Tag(
        name="Access Log Debug",
        description=(
            "Raw log lines kept for troubleshooting. By default only malformed requests are kept, and "
            "LOGPARSER_STORE_DEBUG_LINES=true keeps every line."
        ),
    ),
    Tag(
        name="CrowdSec",
        description=(
            "Decisions, alerts and ban statistics from your CrowdSec LAPI, and banning or unbanning IPs. "
            "Every endpoint except the status answers 404 when the CrowdSec integration is off."
        ),
    ),
    Tag(
        name="Drop",
        description="The networks and ASNs on the Spamhaus DROP lists, and the state of each feed.",
    ),
    Tag(
        name="Reports",
        description="Abuse reports for one IP or one ASN, and the RDAP abuse contact to send them to.",
    ),
    Tag(
        name="Instances",
        description="The head and every agent that sends heartbeats, with the problems each one reports.",
    ),
    Tag(
        name="Logs",
        description="Tail the app and login logs, list and download them and the access log files, and rotate them.",
    ),
    Tag(
        name="System",
        description=(
            "Version and database details, the full settings overview, the release check, the changelog and "
            "the scheduler jobs."
        ),
    ),
    Tag(
        name="Settings",
        description="The settings the web app reads to set itself up, such as retention days and the map defaults.",
    ),
    Tag(
        name="Health",
        description="Liveness and readiness probes for Docker, load balancers and orchestrators. No credentials needed.",
    ),
]
