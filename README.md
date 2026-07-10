# GeoMetrikks

**Status:** ⚠️ This project is in development. Features and APIs will change.

TLDR: GeoMetrikks is a real-time nginx access log ingestion and geo-location tracking service built with Litestar. It parses nginx access logs, performs GeoIP lookups, and stores geo-events and access logs in PostgreSQL with TimeScaleDB/PostGIS extensions.

Data is visualized with GeoJSON on a world map and on a summary dashbord.

## Backend

- Litestar
- TimescaleDB / PostGIS
- Maxmind DB GeoLite2

## Frontend

- React
- Vite
- TanStack
- MapLibre GL
- Carto base maps DarkMatter GL / Positron GL

### Planned features

- Basic auth
- Analytics page with different charts / stats etc
- More map filtering options (Country,City etc)
- Real time log feeds (Geolocation / Access Logs)
- Batch import of access log files
- Caching

## Quickstart (Docker)

All you need is Docker. The app image is published to GHCR for amd64 and arm64.

```bash
mkdir geometrikks && cd geometrikks
curl -LO https://raw.githubusercontent.com/GilbN/geometrikks/main/docker-compose.yml
curl -Lo .env https://raw.githubusercontent.com/GilbN/geometrikks/main/.env.example
$EDITOR .env      # set APP_ADMIN_PASSWORD, MaxMind key, log path
docker compose up -d
```

Then open http://localhost:8000 and log in with `APP_ADMIN_USER` /
`APP_ADMIN_PASSWORD`. The GeoLite2 database is downloaded automatically at
startup when `MAXMINDDB_USER_ID` and `MAXMINDDB_LICENSE_KEY` are set
([free MaxMind account](https://www.maxmind.com/en/geolite2/signup)) and
refreshed weekly. Without credentials the app starts in geo-degraded mode
(a banner in the UI explains what to do); after adding credentials, restart
the app container.

See the [configuration reference](#configuration-reference) for every setting.

## Development

#### Install deps

```bash
pip install uv
uv venv
uv sync --all-extras --dev
bun install
```

#### Run dev server

```bash
docker compose -f docker-compose.dev.yml up -d timescale_db
uv run litestar --app geometrikks.server.core:create_app run --debug
```
See the [configuration reference](#configuration-reference) for configuration.

## Testing

```bash
uv run pytest                    # unit tests — no docker needed
```

Integration tests need the compose TimescaleDB and are marked `integration`.
When the database is unreachable they are skipped automatically, so the plain
run above always stays green.

```bash
docker compose -f docker-compose.dev.yml up -d timescale_db
uv run pytest -m integration     # the real-database suite
```

The integration suite creates a scratch database `geometrikks_it` on the
compose server (migrated to alembic head + timescale objects), and drops it
at session end — it never touches the `geometrikks` dev database. Connection
overrides: `IT_DB_HOST`, `IT_DB_PORT`, `IT_DB_USER`, `IT_DB_PASSWORD`.

CI (`.github/workflows/ci.yml`) runs the integration suite against a
`timescale/timescaledb-ha:pg18` service container via the `IT_DB_*` env vars.

## Authentication

GeoMetrikks ships with single-admin session-cookie authentication. Set the
credentials via environment variables:

```bash
APP_ADMIN_USER=admin          # defaults to "admin"
APP_ADMIN_PASSWORD=change-me  # required — the app refuses to start without it
```

Log in through the web UI (`/login`) or `POST /api/v1/auth/login`. Everything
under `/api/` requires a session; the SPA shell, `/health`, `/health/ready`,
and `/schema` stay open. Sessions are stored in memory, so an app restart
logs everyone out — just log in again.

If an authenticating reverse proxy (Authelia, Tailscale, ...) already fronts
the app, you can disable the built-in auth entirely:

```bash
APP_AUTH_DISABLED=true  # only safe behind an authenticating proxy
```

In this mode the `/api/v1/auth/*` endpoints are not registered (404) and the
sidebar hides the logout button.

## Sending Nginx log metrics with request and upstream response times

1. Add the following to the http block in your `nginx.conf` file:

    ```nginx
    log_format custom '$remote_addr - $remote_user [$time_local] '
            '"$request" $status $body_bytes_sent '
            '"$http_referer" $host "$http_user_agent" '
            '"$request_time" "$upstream_response_time"';
    ```

2. Set the access log use the `custom` log format.

    ```nginx
    access_log /config/log/nginx/access.log custom;
    ```

### Multiple log files

If you separate your nginx log files but want this script to parse all of them you can do the following:

As nginx can have multiple `access log` directives in a block, just add another one in the server block. 

**Example**

```nginx
	access_log /config/log/nginx/somepage/access.log custom;
	access_log /config/log/nginx/access.log custom;
```
This will log the same lines to both files.

## Batch import

Live tailing only picks up lines written after the app starts. To backfill
history — rotated/archived nginx logs, plain or gzip-compressed — use the
`litestar import-logs` CLI command. It reuses the live ingestion pipeline
(same parsing, GeoIP lookup, and DB writes), uses the timestamps in each log
line rather than wall-clock time, and refreshes the continuous aggregates for
the imported time range when it's done.

With the stack running via `docker-compose.yml`, the `app` service already
mounts `${NGINX_LOG_DIR:-/var/log/nginx}` read-only at `/var/log/nginx`, so
rotated/archived files sit right next to the one being tailed:

```bash
docker compose exec app litestar import-logs /var/log/nginx/access.log.1.gz
```

Paths are **container** paths, not host paths. If your archived logs live
outside `NGINX_LOG_DIR`, add another read-only bind mount for them. The
container runs as the non-root `geometrikks` user, so host log files must be
readable by it — the same constraint live tailing already has.

`exec` requires the `app` service to already be running (the normal state).
If the stack is stopped, use `run --rm` instead:

```bash
docker compose run --rm app litestar import-logs /var/log/nginx/access.log.1.gz
```

Running bare-metal/dev instead of via compose:

```bash
LITESTAR_APP=geometrikks.server.core:create_app uv run litestar import-logs /path/to/access.log.1.gz
```

Multiple files can be passed in one invocation.

**Caveats**

- Import archived (rotated) files only — importing a file that's also being
  live-tailed double-counts its lines.
- Each imported file is fingerprinted by content checksum; importing the same
  content again (even under a different filename) is skipped. Pass `--force`
  to re-import — this updates the bookkeeping row but does **not** delete
  rows written by the earlier import.
- A file that doesn't match the expected log format is rejected up front,
  before anything is written.

## Screenshots

![Overview](/data/screenshots/overview.png)

![Map](/data/screenshots/map.png)

## Configuration reference

All settings are environment variables (or a `.env` file next to the app).
`.env.example` lists only the settings most installs touch; this is the full
set. Settings are read once at startup — restart the app after changing them.

### Application

| Variable | Default | Description |
|---|---|---|
| `APP_NAME` | `GeoMetrikks API` | Application name |
| `APP_VERSION` | `0.1.0` | Application version |
| `APP_DEBUG` | `false` | Enable debug mode |
| `APP_ENVIRONMENT` | `production` | `development`, `staging`, `production` |
| `APP_DESCRIPTION` | *(set)* | Application description |

### Authentication

| Variable | Default | Description |
|---|---|---|
| `APP_ADMIN_USER` | `admin` | Admin login username |
| `APP_ADMIN_PASSWORD` | — | **Required** unless auth is disabled; the app refuses to start without it |
| `APP_AUTH_DISABLED` | `false` | `true` = no built-in auth; only safe behind an authenticating reverse proxy (Authelia, Tailscale, ...) |

### API server

| Variable | Default | Description |
|---|---|---|
| `API_HOST` | `0.0.0.0` | Bind address |
| `API_PORT` | `8000` | Port |
| `API_LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |

### Database

| Variable | Default | Description |
|---|---|---|
| `DB_USER` | `geouser` | Database user |
| `DB_PASSWORD` | `geopass` | Database password (change it) |
| `DB_HOST` | `localhost` | Database host |
| `DB_PORT` | `5432` | Database port |
| `DB_DATABASE` | `geometrikks` | Database name |
| `DB_ECHO` | `false` | SQLAlchemy query logging |
| `DB_ECHO_POOL` | `false` | SQLAlchemy pool logging |
| `DB_POOL_SIZE` | `5` | Connection pool size |
| `DB_MAX_OVERFLOW` | `10` | Max connections above pool size |
| `DB_POOL_TIMEOUT` | `30` | Pool timeout (seconds) |
| `DB_POOL_RECYCLE` | `3600` | Connection recycle time (seconds) |
| `DB_POOL_DISABLED` | `false` | Disable connection pooling |
| `DB_POOL_PRE_PING` | `true` | Pre-ping connections |
| `DB_DROP_ON_STARTUP` | `false` | Drop all tables on startup (only honored in `development`) |

### GeoIP (MaxMind GeoLite2)

| Variable | Default | Description |
|---|---|---|
| `MAXMINDDB_USER_ID` | — | MaxMind account ID for GeoLite2 auto-download ([free account](https://www.maxmind.com/en/geolite2/signup)) |
| `MAXMINDDB_LICENSE_KEY` | — | MaxMind license key for GeoLite2 auto-download |
| `GEOIP_REFRESH_DAYS` | `7` | Re-download the database when older than this many days |
| `GEOIP_DB_PATH` | `data/geoip/GeoLite2-City.mmdb` | Path to the GeoLite2 database (`/app/data/geoip/GeoLite2-City.mmdb` in the image) |
| `GEOIP_LOCALES` | `["en"]` | GeoIP locales |
| `GEOIP_VALIDATE_DB_PATH` | `false` | Fail fast at startup when the database file is missing (off by default; the downloader/degraded mode owns that case) |
| `GEOIP_VALIDATE_LOCALES` | `true` | Validate the locale list |

Without credentials and without an existing database the app starts in
**geo-degraded mode**: the API and UI stay up, but ingestion does not start
and a banner explains what to configure. The database file on disk is
replaced atomically by the weekly refresh; the new file is picked up on the
next app restart.

### Log parser

| Variable | Default | Description |
|---|---|---|
| `LOGPARSER_LOG_PATHS` | `/var/log/nginx/access.log` | Single path, or a JSON list: `["/var/log/nginx/access.log", "/var/log/nginx/other.log"]` |
| `LOGPARSER_POLL_INTERVAL` | `1.0` | Poll interval (seconds) for new lines |
| `LOGPARSER_SEND_LOGS` | `true` | Store parsed access logs (otherwise geo-events only) |
| `LOGPARSER_HOST_NAME` | *(hostname)* | Host label attached to ingested events |
| `LOGPARSER_BATCH_SIZE` | `100` | Max records before a forced commit |
| `LOGPARSER_COMMIT_INTERVAL` | `5.0` | Max seconds between commits |
| `LOGPARSER_SKIP_VALIDATION` | `false` | Skip log format validation |
| `LOGPARSER_STORE_DEBUG_LINES` | `false` | Store all raw lines in the debug table (otherwise only malformed ones) |

### Analytics & scheduler

| Variable | Default | Description |
|---|---|---|
| `ANALYTICS_RAW_RETENTION_DAYS` | `180` | Days to keep raw geo events and access logs |
| `ANALYTICS_DEBUG_RETENTION_DAYS` | `30` | Days to keep debug log lines |
| `ANALYTICS_HOURLY_RETENTION_DAYS` | `60` | Days to keep hourly aggregates (daily aggregates are permanent) |
| `ANALYTICS_CAGG_REFRESH_INTERVAL_MINUTES` | `5` | Continuous-aggregate refresh cadence |
| `ANALYTICS_COMPRESSION_AFTER_DAYS` | `7` | Compress hypertable chunks after this many days |
| `ANALYTICS_TOP_IPS_LIMIT` | `1000` | Top IPs tracked per day |
| `ANALYTICS_TOP_URLS_LIMIT` | `500` | Top URLs tracked per day |
| `SCHEDULER_ENABLED` | `true` | Enable background jobs (CAGG refresh, GeoLite2 refresh, ...) |
| `SCHEDULER_DAILY_ROLLUP_HOUR` | `0` | Hour (UTC) for the daily rollup |
| `SCHEDULER_DAILY_ROLLUP_MINUTE` | `5` | Minute for the daily rollup |
| `SCHEDULER_LOCATION_REFRESH_INTERVAL_MINUTES` | `5` | `GeoLocation.last_hit` refresh cadence |