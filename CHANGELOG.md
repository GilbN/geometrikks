# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Single-admin session-cookie authentication (`APP_ADMIN_USER` / `APP_ADMIN_PASSWORD`), with `APP_AUTH_DISABLED=true` reverse-proxy mode. New endpoints: `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`.
- `/health/ready` readiness endpoint (503 until the database answers).
- Login page, automatic redirect to it on API 401 responses, and a logout button in the sidebar (hidden when auth is disabled).
- Real-TimescaleDB integration test suite (`pytest -m integration`): startup migrations, end-to-end ingestion (rows/rotation/poison-recovery), repository CAGG-routing.

### Changed

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
