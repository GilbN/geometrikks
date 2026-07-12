# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-12

### Added

- `litestar import-logs` CLI command for batch-importing historical nginx
  access logs (plain or gzip), reusing the live ingestion pipeline. Checksum
  duplicate protection skips a file already imported (`--force` to
  re-import), and a post-import refresh of the continuous aggregates covers
  the imported time range.
- `/analytics` page with per-bucket charts (requests, status classes,
  bandwidth, latency avg/p50/p95/p99) and top-URLs / top-user-agents tables.
- New analytics endpoints: `GET /api/v1/analytics/time-series`,
  `/analytics/geo-time-series`, `/analytics/top-urls`,
  `/analytics/top-user-agents`.
- Country/city filters on the map: repeatable `country_code` / `city` query
  params on `GET /api/v1/geo-locations/geojson` plus multi-select comboboxes
  in the map controls.
- The generated `@hey-api/openapi-ts` client is now the typed transport for
  the new frontend fetchers; the drifted hand-written GeoJSON/time-series
  interfaces were removed in favor of generated types.
- Authenticated `/ws/live` WebSocket streaming committed ingestion events
  (geo-events + access-logs) to the browser as batched, coalesced JSON
  frames (~6.7 frames/s, per-frame event cap, and a `dropped` counter on
  burst overflow). The handshake is authenticated by the same session
  cookie as the REST API, and stays open when `APP_AUTH_DISABLED=true`.
- Live geo-event pulses on the map, behind a "Live" toggle in the map
  controls.
- Historical + live-tail access-log views at `/access-logs`: a time-scoped,
  newest-first, paginated table (History mode) and a virtualized live-tail
  (Live mode, prepend + pause-on-hover), switched by a History/Live toggle.
- Live-feed connection status indicator in the sidebar, with auto-reconnect
  and exponential backoff.

### Fixed

- Summary CAGG percentiles are now mathematically correct: buckets store a
  mergeable `percentile_agg` (uddsketch) and queries read
  `approx_percentile(...)` rollups, instead of averaging per-bucket
  percentiles (an AVG of p50s/p95s/p99s is not a percentile).
- `get_time_series` / `get_geo_time_series` raised for ranges ≤ 24 h (they
  built a nonexistent `summary_raw_stats` table name); sub-24h ranges now
  clamp to the hourly CAGGs, which real-time aggregation keeps current.
- The map no longer remounts its GeoJSON source (and every layer) on each
  data refresh, and fit-to-bounds no longer risks a stack overflow on large
  feature sets (spread-based `Math.min/max` replaced with a single pass).
- Chart palette (`--chart-1..5`) replaced with CVD-validated sets for both
  themes; the previous light palette's 4xx/5xx hues were indistinguishable
  under deuteranopia.

### Changed

- **Summary CAGG schema changed and is auto-upgraded on startup**: old-shape
  `summary_hourly_stats` / `summary_daily_stats` views are dropped and
  recreated, and their materialized data is rebuilt from raw access logs.
  Raw logs only survive `raw_retention_days` (default 180 d), so summary
  history older than that cannot be rebuilt and **is permanently lost** by
  the upgrade (the daily CAGGs were its only permanent store).
- `/analytics/summary` percentile values change where the old averaging math
  was wrong (intended).

## [0.1.0-alpha.1] - 2026-07-10

### Added

- GeoLite2-City auto-download from MaxMind at startup and on a weekly
  scheduler job (`MAXMINDDB_USER_ID` / `MAXMINDDB_LICENSE_KEY`,
  `GEOIP_REFRESH_DAYS`). The database is replaced atomically; a failed
  refresh keeps the existing copy.
- Geo-degraded mode: without a GeoLite2 database the app starts anyway
  (API + UI up, ingestion paused) with an actionable warning log, a
  `geoip.available` component in `/health`, and a banner in the web UI.
- CI workflow (GitHub Actions): ty type check, pytest — unit plus the
  integration suite against a TimescaleDB service container — and the
  frontend build.
- Release workflow: multi-arch (linux/amd64 + linux/arm64) image publishing
  to `ghcr.io/gilbn/geometrikks` on `v*` tags.
- User-facing `docker-compose.yml` that pulls the published GHCR image
  (named volumes for the database and the GeoLite2 file, read-only nginx log
  mount); the development stack moved to `docker-compose.dev.yml`.
- Full configuration reference as a README appendix.
- Single-admin session-cookie authentication (`APP_ADMIN_USER` / `APP_ADMIN_PASSWORD`), with `APP_AUTH_DISABLED=true` reverse-proxy mode. New endpoints: `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`.
- `/health/ready` readiness endpoint (503 until the database answers).
- Login page, automatic redirect to it on API 401 responses, and a logout button in the sidebar (hidden when auth is disabled).
- Real-TimescaleDB integration test suite (`pytest -m integration`): startup migrations, end-to-end ingestion (rows/rotation/poison-recovery), repository CAGG-routing.

### Changed

- The Docker image no longer bundles a GeoLite2 database; `/app/data/geoip`
  is a volume owned by the auto-downloader.
- `.env.example` trimmed to the settings a typical install actually touches.
- Geo records whose GeoIP lookup lacks country data are skipped instead of
  failing the ingest batch (the columns are NOT NULL).
- Standardized on bun as the JS package manager; removed npm lockfile.
- Pinned all frontend dependencies (previously `"latest"`).
- Removed duplicate alembic scaffold; `migrations/` is canonical.
- Removed bundled MaxMind GeoLite2 databases from the repository and its
  history (GeoLite2 EULA); tests use the redistributable MaxMind test database.
- Log ingestion now tails multiple files via `LOGPARSER_LOG_PATHS` (single path or JSON list); the singular `LOGPARSER_LOG_PATH` is removed.
- Log rotation is handled with a reopen loop (no more leaked file descriptors on rotation).
- Ingestion commits each batch in a short-lived database session and recovers automatically from database restarts.
- Database schema is now managed by alembic migrations (baseline revision
  included); startup runs `alembic upgrade head` automatically and fails
  fast if a migration breaks. `DB_DROP_ON_STARTUP` is only honored when
  `APP_ENVIRONMENT=development`. Pre-existing databases (from the old
  `create_all` startup path) must be stamped once with
  `litestar database stamp head` before first startup on this version.
- `/settings` and `/stats` moved under `/api/v1/`.
- `/health` now always returns 200 while the app runs; component states (ingestion, database) moved into the payload.
- With `APP_AUTH_DISABLED=true` the `/api/v1/auth/*` endpoints are not registered (404) instead of erroring without session middleware.
- `refresh_caggs_range` now takes `datetime` bounds and binds them as query parameters.

### Fixed

- Vite `@` alias resolved to the filesystem root instead of `resources/`.
- Stale geo-location cache entries after a rollback no longer poison subsequent inserts.
- Location-cache entries that predate the current run (e.g. after a crashed commit) are evicted when a flush fails, so a poisoned id cannot wedge ingestion permanently.
- Server modules no longer fail to import when the GeoIP database is missing.
- CAGG summary returned no data for ranges with geo events but zero access logs.
- `provice_summary_stats_repo` typo.

### Security

- Settings endpoint no longer exposes the full settings tree (database credentials leaked via `model_dump()`); response is now an explicit whitelist.
- Timestamps in `CALL refresh_continuous_aggregate` are bound as asyncpg parameters instead of interpolated into SQL.

[Unreleased]: https://github.com/GilbN/geometrikks/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/GilbN/geometrikks/compare/v0.1.0-alpha.1...v0.1.0
[0.1.0-alpha.1]: https://github.com/GilbN/geometrikks/releases/tag/v0.1.0-alpha.1
