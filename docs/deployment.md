# Deployment

How the production container runs, what it assumes, and which knobs are safe
to turn. The canonical image is built from `Dockerfile` and published to GHCR;
`docker-compose.dev.yml --profile prod` shows a working single-container
setup.

## Runtime model

The image runs Granian through the Litestar CLI:

```
tini (PID 1) -> entrypoint.sh (PUID/PGID remap, drops root via gosu)
  -> litestar run --workers 1 --no-subprocess   (becomes the Granian master)
    -> granian worker
```

- `--no-subprocess` is load-bearing: litestar-granian's default subprocess
  mode spawns Granian as a child and the CLI wrapper does not forward
  SIGTERM, so `docker stop` would kill the wrapper and the PID namespace
  would take Granian down without any lifespan teardown. In direct mode the
  CLI process is the Granian master and Granian's own SIGTERM/SIGINT
  handlers run the graceful path.
- `tini` forwards signals through the exec chain and reaps orphans. The
  entrypoint remaps the runtime user to `PUID`/`PGID` (default 1000:1000),
  fixes volume ownership, then execs the CMD; with a non-root `user:`
  override it just execs.
- The application is installed into the venv as a built wheel; the image
  carries no source checkout. `migrations/` and `alembic.ini` live at `/app`
  because alembic resolves them relative to the working directory.

### Shutdown

`STOPSIGNAL SIGTERM`. On stop, lifespan managers exit in reverse startup
order: ingestion drains and stops first, the scheduler shuts down, the
CrowdSec LAPI client closes last, then workers exit. A normal shutdown
completes in a few seconds.

Timeout budget: ingestion waits up to 5s for its tail tasks before
cancelling them, and the image sets Granian's worker kill timeout to 15s,
so give Docker at least 20s (`docker stop -t 20`, or compose
`stop_grace_period: 20s`) to keep Docker's own SIGKILL out of the picture.
A tail task still waiting for its log file to appear, or waiting for that
file to receive its first parseable line, ends that wait as soon as the
stop is signalled rather than sitting out its own 60s timeout.

### Logging

Granian's server log is enabled (info); its access log is disabled on
purpose: request logging is owned by the structlog middleware, so every
request is logged once, structured, with the same pipeline as application
events.

## The single-worker constraint

`--workers` (or `LITESTAR_WEB_CONCURRENCY`/`WEB_CONCURRENCY`) must stay at 1.
Nothing in the runtime is coordinated across processes:

- Admin sessions live in an in-memory server-side store; a second worker
  would randomly reject logged-in users.
- The WebSocket feeds (`/ws/live`, `/ws/crowdsec`, logs) fan out from
  process-local brokers; clients on another worker would see nothing.
- APScheduler and the log-ingestion pipeline run inside the app process;
  two workers means duplicate scheduled jobs and double ingestion of every
  log line.
- Startup migrations (below) are not locked across processes.

Raising the worker count is a design change (shared session store, channel
backend or fan-out service, external scheduler/ingestion ownership, and
migration locking), not a tuning knob.

## Migration ownership

- Default (`DB_MIGRATE_ON_STARTUP=true`): the container runs alembic
  migrations at startup. Correct for the single-container homelab flow.
- Separate-step deployments: set `DB_MIGRATE_ON_STARTUP=false` and run
  `litestar database upgrade` as a dedicated deploy step. The image sets
  `LITESTAR_APP`, but composing the app still needs the normal deployment
  environment (database settings, `APP_ADMIN_PASSWORD`), and the command
  prompts for confirmation unless told not to:

  ```bash
  docker run --rm --env-file .env <image> \
    litestar database upgrade --no-prompt
  ```

  The app then expects the schema at head.
- TimescaleDB objects (hypertables, continuous aggregates, policies) are
  always configured at startup. That step is idempotent but requires the
  schema to be at head, and it failing is the deliberate signal that the
  external migration step was skipped.
- The first start on a version that adds columns to a continuous
  aggregate (the timed-row counts, then the latency columns that skip
  WebSocket connections, on the summary and URL aggregates) adds them in
  place and then re-materializes those aggregates over the raw retention
  window. That refresh runs inside startup, so the head container answers
  nothing, `/health` included, until it finishes; on a database with tens
  of millions of rows expect minutes, and watch for `cagg_column_added`
  followed by `cagg_columns_refresh_done` in the logs. No history is lost,
  and a container stopped mid-way resumes the refresh on its next start. A
  database that is several versions behind gets every missing column in
  one pass and one refresh. Buckets older than the raw retention window
  keep their pre-upgrade figures, computed over every row, because the raw
  rows needed to recount them are gone. A TimescaleDB without in-place
  aggregate columns (the compose images pin a version that has them) falls
  back to dropping and recreating the aggregate, which discards daily
  history older than the raw retention window.
- The first start on a version that changes how an aggregate groups its
  rows (the URL aggregates gained a host dimension so Top URLs can tell
  `app-a.example.com/graphql` from `app-b.example.com/graphql`) drops and
  recreates that aggregate, then re-materializes it over the raw retention
  window inside startup, like the column upgrade above. Watch for
  `url_caggs_recreated` in the logs. Per-URL daily history older than the
  raw retention window is discarded, because the raw rows needed to rebuild
  it are gone; every other aggregate is untouched.

## Health

- `/health`: liveness plus component detail (database, GeoIP, ingestion).
  Used by the image's `HEALTHCHECK`.
- `/health/ready`: readiness; returns 503 while degraded.

The API starts in degraded mode when the database is unreachable and in
geo-degraded mode without a GeoLite2 database; see `docs/configuration.md`
for the involved settings.
