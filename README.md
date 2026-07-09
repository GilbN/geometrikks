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

#### Install deps

```bash
pip install uv
uv venv
uv sync --all-extras --dev
bun install
```

#### Run dev server

```bash
docker-compose up -d
uv run litestar --app geometrikks.server.core:create_app run --debug
```
See .env.example for configuration

## Testing

```bash
uv run pytest                    # unit tests — no docker needed
```

Integration tests need the compose TimescaleDB and are marked `integration`.
When the database is unreachable they are skipped automatically, so the plain
run above always stays green.

```bash
docker compose up -d timescale_db
uv run pytest -m integration     # the real-database suite
```

The integration suite creates a scratch database `geometrikks_it` on the
compose server (migrated to alembic head + timescale objects), and drops it
at session end — it never touches the `geometrikks` dev database. Connection
overrides: `IT_DB_HOST`, `IT_DB_PORT`, `IT_DB_USER`, `IT_DB_PASSWORD`.

> CI note (Phase 1.5): `ci.yml` should run the integration suite with a
> `timescale/timescaledb-ha:pg18` service container — the `IT_DB_*` env vars
> exist for exactly that.

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

## Screenshots

![Overview](/data/screenshots/overview.png)

![Map](/data/screenshots/map.png)