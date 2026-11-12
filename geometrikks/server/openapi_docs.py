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
`/api/v1/auth/login`, `/api/v1/auth/options` and the OIDC login routes `/api/v1/auth/oidc/start` and \
`/api/v1/auth/oidc/callback` need neither. A server started with \
`APP_AUTH_DISABLED=true` asks for no credentials at all, and you cannot create keys on it.

To test a connection, call `GET /api/v1/auth/connection`. It reports the app/API version, \
authentication mode and configured features. With a key it also returns that key's name, scope and \
expiry, without returning the secret. Invalid and expired keys get a coded 401. `mode: disabled` \
means authentication is off and a supplied key has not been checked. Capabilities describe \
configuration, not current upstream health or permission to write with a Read key.

## Scopes

Every key has one of two scopes.

- **Read** keys can send `GET` and `HEAD` requests and open the WebSocket feeds `/ws/live`, \
`/ws/crowdsec` and `/ws/logs`. Any other method gets a 403.
- **Read/write** keys can also ban and unban IPs, ban DROP networks, run a scheduler job, rotate \
the log files and delete server locations and retired instances.

No key can list, create or revoke keys, log out, call `/api/v1/auth/me` or read \
`/api/v1/auth/oidc/status`. Those endpoints answer every key with a 403 and need a browser session.

## Errors

An API error response includes the HTTP status, a message and a stable machine-readable code:

```json
{"status_code": 404, "detail": "The API key does not exist.", "code": "not_found"}
```

When a parameter fails validation, the 400 response adds an `extra` list that names each bad \
parameter:

```json
{
  "status_code": 400,
  "code": "validation_failed",
  "detail": "Validation failed for GET /api/v1/logs/tail?lines=abc",
  "extra": [{"message": "Expected `int`, got `str`", "key": "lines", "source": "query"}]
}
```

Branch on the HTTP status and `code`, not the wording of `detail`. Unknown codes fall back to \
the HTTP status. Unexpected internal errors may omit `code`.

Key failures use `api_key_invalid`, `api_key_expired`, `api_key_read_only`, `session_required` or \
`api_keys_unavailable`. Parameter errors use `validation_failed` or `invalid_request`. Resource \
errors use `not_found` or `conflict`. CrowdSec failures use `crowdsec_unreachable`, \
`crowdsec_credentials_rejected` or `crowdsec_unsupported`. Other failures use a code matching the \
status, such as `not_authenticated`, `forbidden` or `unavailable`.

Error keys are snake_case. Successful responses use camelCase keys. `/health/ready` is the one \
exception to this shape, and its 503 body is `{"ready": false}`.

The status codes mean:

- **400** A parameter or the body failed validation, for example an IP that does not parse, or a CrowdSec \
request needs a newer LAPI than the one configured.
- **401** The request carries no session and no key, or the key is malformed, unknown, revoked or expired.
- **403** A Read key sent a write, a key called an endpoint that needs a browser session, or a \
CrowdSec ban, unban or alert endpoint reached a server without CrowdSec machine credentials.
- **404** No route or no resource matches. CrowdSec endpoints other than the status also answer 404 \
when the CrowdSec integration is off.
- **409** The request conflicts with the current state, for example a key name that is taken.
- **415** `POST /api/v1/auth/api-keys` got a body that is not `application/json`.
- **500** CrowdSec rejected the configured credentials, or the server hit an unexpected error.
- **502** The CrowdSec LAPI or an RDAP registry failed to answer or answered with an error.
- **503** The database is unreachable. Checking an API key needs the database, so requests with a key \
get a 503 until it is back. `/health/ready` also answers 503 on an agent whose startup schema check \
timed out, even while the database answers.

## Time ranges

Every analytics endpoint and the abuse report take the range as `startDate` and `endDate`. The geo \
event, geo location, access log, access log debug and CrowdSec banned-location endpoints call it \
`fromTimestamp` and `toTimestamp`. Send them as ISO 8601 with a timezone, such as \
`2026-11-01T00:00:00Z`. GeoMetrikks stores times in UTC and returns them in UTC. A response that echoes \
`startDate` and `endDate` keeps the offset you sent.

Every `/api/v1/analytics` endpoint accepts `window=15m`, `window=24h` or `window=7d` instead of \
explicit dates. Use positive whole minutes, hours or days, up to 365 days. Responses echo the \
resolved bounds. Mixing modes, omitting one bound, using no timezone or sending an empty or inverted \
analytics range returns 400 with `code: invalid_range`.

`/api/v1/analytics/time-series`, `/api/v1/analytics/geo-time-series` and \
`/api/v1/geo-events/time-series` use hourly buckets for ranges up to 30 days and daily buckets for \
longer ones, and their `granularity` parameter forces either size. Every response with buckets names \
the size it used in `granularity`. Daily buckets are UTC days unless you pass `tz` with an IANA zone \
such as `Europe/Oslo`. `tz` makes daily buckets local days on ranges of 30 days or less, and longer \
ranges keep UTC days unless the endpoint's description says otherwise. Those shorter ranges get hourly \
buckets unless you send `granularity=daily`, and `tz` changes nothing on hourly buckets.

For recent access-log polling, use `/api/v1/access-logs?window=10m&orderBy=id&sortOrder=asc`. \
`X-Range-Start` and `X-Range-End` echo inclusive bounds. URL-encode them as `fromTimestamp` and \
`toTimestamp` for later pages, dropping `window`, and deduplicate records by `id` across polls. \
Pages are not a snapshot; choose overlap longer than the polling interval and ingestion delay. \
Late imports and backfills are outside this polling contract. An ID is not a commit-order cursor.

## Dashboard summary

`GET /api/v1/integration/summary?window=24h` combines traffic totals, instance health, local \
ingestion and active CrowdSec decisions. Each section reports `available`, `reason` and `data`; \
unavailable data is null rather than zero. `latestEventAt` is retained log time. Parser freshness \
is per process and does not prove a database commit. The CrowdSec count makes one LAPI request \
with a two-second deadline. Use the detailed endpoints when you need individual records.

## Source activity

`GET /api/v1/instances` includes each instance's sources in `payload.sources`. Each source reports \
`lastReadAt` when it last delivered a new line and `lastParsedAt` when it last produced a parsed record \
with a client IP. Unmatched lines and ignored IPs advance only `lastReadAt`. Format samples, empty \
polls and Loki overlap duplicates advance neither. The timestamps use the instance's clock and \
arrive with its heartbeat, normally every 30 seconds. Check `lastSeen` and `checkingIn` too. Null \
means no activity yet or an older agent. They reset when the instance restarts. They measure \
processing activity, not log timestamps or database commits.

## Pagination

Paged lists take `currentPage`, counted from 1, and `pageSize`. They answer with `items`, \
`total`, `limit` and `offset`, where `total` counts the matches on every page. \
`/api/v1/crowdsec/drop-networks` does not follow this shape. It takes `page` and a `pageSize` of at \
most 100, and answers with `items`, `totalNetworks` and traffic totals, with no `limit` or `offset`. \
`/api/v1/crowdsec/alerts` pages by cursor. Pass the `nextCursor` of one response as `before` to get \
the next, older page. Top lists take a `limit` instead and have no pages.
"""

API_TAGS: list[Tag] = [
    Tag(name="Integrations", description="A compact overview for scripts and dashboard widgets, with per-section availability."),
    Tag(
        name="Auth",
        description=(
            "Log in and out of the web app, see who is logged in, and list, create and revoke API keys. "
            "Login, the login options and the OIDC login routes need no credentials. Everything else here "
            "needs a browser session."
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
        name="AbuseIPDB",
        description=(
            "Check IPs on AbuseIPDB and report them there. Checks need ABUSEIPDB_API_KEY, reports also need "
            "ABUSEIPDB_REPORTING_ENABLED=true, and the blacklist also needs ABUSEIPDB_BLACKLIST_ENABLED=true."
        ),
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
        description=(
            "Liveness and readiness probes for Docker, load balancers and orchestrators. No credentials needed."
        ),
    ),
]
