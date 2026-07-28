# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Analytics top lists (URLs, user agents, IPs, countries, cities) are now
  served from continuous aggregates on ranges over 24 hours instead of
  scanning raw access logs, making long-range views much faster. The IP,
  country and city lists stay on the fast path even with country/city/IP
  filters; filtered URL and user-agent lists still scan raw logs.
- Geo Logs summary and chart stay on the fast aggregate path when filtered
  by country, city or IP on ranges over 24 hours. Hostname filters still
  scan raw events.
- Access Logs country and city filter dropdowns load from aggregates
  instead of scanning the full log history, and now list values from all
  recorded history rather than only the raw retention window.

### Fixed

- Map top-IP lists (global and per-location) no longer include events from
  outside the selected range on ranges over 24 hours: the window was
  previously floored to whole days, over-counting the partial first day.
- Geo Logs chart on ranges up to 24 hours no longer includes events from just
  before the selected window in its first data point, and its unique-IP counts
  on those short ranges are exact instead of estimated.

## [0.5.0] - 2026-07-25

### Added

- Access Logs: include/exclude filters for client IP and for HTTP host. Host
  is now picked from the hosts present in your data rather than typed as a
  substring, and both filters accept several values at once.
- Access Logs and Analytics filters live in the URL, so a filtered view is a
  shareable link. Access Logs also carries its page, page size and sort
  order, matching the Geo Logs page.
- Analytics page: an exclude-IP filter. Every chart and top-list on the page
  can now drop specific client IPs, which is the quick way to take your own
  traffic out of the picture without changing ingestion settings.
- The docker image now supports `PUID`/`PGID`: the
  entrypoint re-maps the container user, fixes ownership of `/app/logs` and
  the GeoIP volume at startup, then drops privileges with gosu - no more
  `mkdir`/`chown` pre-step before `docker compose up -d`. Containers started
  with a `user:` override keep today's fully non-root behavior.
- New `LOG_*` settings: `LOG_LEVEL`, `LOG_DIR`, and size/backup-count
  limits for the main and login log files.
- Logs API: `GET /api/v1/logs/tail`, `GET /api/v1/logs/files`, per-file
  download at `GET /api/v1/logs/files/{kind}/{name}`, and
  `POST /api/v1/logs/rotate` for on-demand rotation. `/ws/logs` streams
  structured log events live, with an optional `?level=` minimum-level
  filter.
- Logs page at Settings -> Logs: live log stream with level/component
  filters, search, pause, and traceback/detail dialogs. Tabs switch between
  the system log, the login log, and a Downloads tab listing the raw files
  (app log, login log, gzip archives, ingested nginx access logs) with a
  "Rotate logs" button.
- `GET /api/v1/system/settings` and the Settings -> Environment overview now
  surface runtime-resolved values raw config can't show: the auto-detected
  map home coordinates (badged "auto-detected"), and GeoIP database
  availability plus CrowdSec's effective `enabled`/`write_enabled` status
  (both badged "runtime").
- `LOGPARSER_IGNORE_IPS` setting: IPs/CIDRs the parser drops entirely so
  your own traffic through the reverse proxy is never ingested (applies to
  live tailing and file imports).
- Map controls: a "Go to home location" button next to "Fit to data bounds"
  that flies the map to the configured/auto-detected home coordinates. Shown
  only when a home location is resolved.
- Home location marker: a home-icon pin on the map at the
  configured/auto-detected home coordinates; clicking it zooms to the home
  location. Toggled via "Home marker" in the map controls (on by default,
  preference stored in the browser).
- Live map packets are now colored by response status (green/blue/amber/red)
  and sized by response bytes, with a dashed red ring cage over packets from
  banned IPs.
- Live rail: a glass column over the map's left edge holding the whole live
  picture while live mode is on. Requests per minute with a sparkline and a
  trend against the first half of the window, a response-mix bar, the busiest
  origin countries in that window, and the request feed itself split into an
  "All" and a "Threats" lane. The threat lane holds requests the server
  refused (401, 403, 429, 444) and everything from a banned IP; a 404 is
  ordinary traffic and stays out of it. A footer counts distinct banned IPs
  seen. The
  rail can be switched off from the "Live overlays" card in the map controls,
  and the choice is remembered in the browser.
- Live mode on a phone shows a vitals pill with the current rate, a sparkline,
  and a red threat count when anything is attacking. Tapping it opens a sheet
  carrying the same summary and feed as the desktop rail, and tapping a row
  flies the map to that request's origin.
- Clicking a live packet or a row in the rail or sheet flies the map to that
  request's origin and opens its full access-log line, with ban/unban
  controls.

### Changed

- Map surfaces (controls panel, zoom buttons, and location popups) now share
  the live overlays' translucent glass styling, so the map stays visible
  through every panel.
- Scrollbars throughout the app are slim, rounded, and tinted to the theme
  instead of the browser's default grey channel, in every scrolling panel and
  on the page itself.

- Logging is now structured (structlog): colored console output, a JSONL
  main log (`logs/geometrikks.log`), and a plain-text login log
  (`logs/login.log`) in a CrowdSec/fail2ban-friendly format. Both rotate by
  size and gzip their archives.
- Logins, failed logins, and logouts now emit `login_success`,
  `login_failed`, and `logout` events to `logs/login.log`.
- Scheduler job outcomes are logged centrally: `scheduler_job_completed`
  (SUCCESS), `scheduler_job_failed` (ERROR), and `scheduler_job_missed`
  (WARNING), with `job_id` and duration.
- All app modules log through the structlog pipeline, and subsystems emit
  lifecycle and state-change events (WS connects, scheduler outcomes,
  CrowdSec stream state, GeoIP refreshes, imports); completed jobs use a
  new SUCCESS level.
- Swapped the `picologging` litestar extra for `structlog`.
- `docker-compose.yml` mounts `./logs:/app/logs` so logs persist across
  container recreation and `login.log` is readable by host tools. If the
  directory is not writable, the app falls back to console-only logging
  with a startup error instead of crashing.

### Deprecated

- `API_LOG_LEVEL` in favor of `LOG_LEVEL`; still honored as a fallback,
  with a `DeprecationWarning`.

### Removed

- The `host` substring query parameter on `GET /api/v1/access-logs/`. Replaced
  by exact-match `hostIn` and `hostNotIn`, which the new Host filter dropdown
  uses. Breaking for anyone calling that endpoint directly.
- The map legend: the color-graded event count/density scale duplicated what
  the marker and heatmap colors already say at a glance, so the card is gone
  and the bottom-left corner stays clear for the map.

### Fixed

- Map zoom/compass buttons were unclickable when the map-controls panel was
  tall enough to reach down beside them.
- The location popup's close button sat on top of the place name instead of
  beside it, because the card it anchors to was never positioned. The live
  request popup's close button covered its timestamp the same way.
- The live surfaces no longer read as disconnected during demo traffic, which
  never opens the websocket.
- A live request with no GeoIP match (LAN traffic, private or unresolvable
  IPs) now opens a small dismissible detail card when tapped from the rail
  or the phone sheet, instead of doing nothing.
- Switching Live mode off now closes an open live-request popup and the
  phone feed sheet along with the rest of the overlay state, clicking the
  heatmap layer dismisses an open live popup, and zooming into a cluster no
  longer leaves one stuck open.
- Geo Logs: the IP include/exclude inputs now reject invalid text instead of
  accepting it as a filter chip, which used to reach the API and come back
  as a 400.

## [0.4.3] - 2026-07-22

### Fixed

- Fixed the stale GeoLite database check. The database_is_stale function looked at the modified time of the file instead of the build time of the database. Moved the private _geoip_info function into /lib/utils.py, and database_is_stale uses that to check instead.
- Fixed a stale service worker breaking production loads (blank page, module
  MIME-type errors): the app shell at `/` is no longer precached (navigations
  are NetworkFirst with the cached shell as offline fallback), and `/sw.js`
  404s while `VITE_DEV_MODE=true` so a dev-mode server can never install the
  worker.
- `/api/v1/access-logs` now runs separate page and count queries instead of a
  `count(*) OVER ()` window function, cutting large time-range requests from
  15+ s to ~130 ms on a 17M+ dataset.


## [0.4.2] - 2026-07-22

### Fixed

- The PWA manifest link now uses `crossorigin="use-credentials"` so the
  browser sends session cookies when fetching `manifest.webmanifest`; without
  it the fetch is credential-less and 401s behind cookie-auth reverse proxies
  (Organizr/Authelia `auth_request`).

## [0.4.1] - 2026-07-22

### Added

- `APP_SESSION_SECURE` (default `false`): mark the session cookie `Secure`;
  recommended behind a TLS reverse proxy.
- `APP_TRUSTED_PROXIES` (IPs/CIDRs, default empty): trust `X-Forwarded-For`
  from these proxies so the app can resolve real client IPs.
- Login successes and failures are now logged with username and client IP.

### Fixed

- `/ws/live` and `/ws/crowdsec` now send an empty keepalive frame after 30s of
  silence so reverse proxies (nginx `proxy_read_timeout`, 60s default / 240s in
  SWAG) no longer cut idle live-feed connections on quiet servers.
- WebSocket reconnect backoff (`/ws/live`, `/ws/crowdsec`) resets on a valid
  frame instead of on open, ending the 1s reconnect loop while the server
  closes with 1013.
- The `/ws/crowdsec` client ignores non-string/malformed frames instead of
  throwing.

## [0.4.0] - 2026-07-21

### Added

- CrowdSec integration: point `CROWDSEC_LAPI_URL` + `CROWDSEC_BOUNCER_API_KEY`
  at a CrowdSec Local API for read access; add `CROWDSEC_MACHINE_ID` +
  `CROWDSEC_MACHINE_PASSWORD` to enable ban/unban.
  - Security page (sidebar entry shown when configured): stat cards, the
    active-decisions table with origin-scope tabs (local / all / crowd),
    per-row unban, a "Seen 24h" column cross-referencing banned IPs against
    the server's own traffic, alert history with a time-window picker, and a
    manual "Ban IP" dialog with duration picker and optional reason.
  - "Banned" badge and a ban/unban shield action on IPs in the access-logs
    table, the Analytics and Geo Logs top-IP tables, map popups, and
    IP-scoped alert rows. Bans take a duration (1h to forever) and are
    audit-logged with the acting user.
  - Map overlay: a "Banned IPs" toggle rendering red markers for banned IPs
    seen in this server's own traffic within the selected time range.
  - Live updates: the LAPI decision stream is polled
    (`CROWDSEC_STREAM_POLL_INTERVAL`, default 15s) and pushed over a
    `/ws/crowdsec` WebSocket, so banned badges update within seconds of a
    decision anywhere in CrowdSec.
  - REST API under `/api/v1/crowdsec/`: `status`, `decisions` (paginated,
    geo-enriched), `decisions/lookup`, `stats`, `banned-ips`,
    `banned-locations`, `alerts` (filterable by ip/scenario/since), `ban`
    and `unban`. Decision listings default to local origins so an opted-in
    CAPI community blocklist doesn't flood the view.

## [0.3.0] - 2026-07-19

### Fixed

- Larger touch targets on touch devices across the app: header controls, sidebar trigger, filter/columns/clear buttons on the table pages, map controls drawer, custom-range apply, and settings page buttons; small mobile layout fixes on Overview and Environment pages.
- Live tail no longer freezes permanently after a tap on touch devices; added an explicit pause/resume button and a narrower mobile column set.
- Focusing any input on a touch device no longer triggers the iOS auto-zoom.
- Mobile sidebar closes automatically after navigating.
- Table pagination footers no longer overflow on narrow screens; all tables share one responsive footer component.
- Geo Logs counts no longer disagree with the Analytics page on ranges over 24h.
  The per-IP CAGG reads floored the window start to a whole bucket, silently
  counting a partial extra bucket that the raw analytics scan excluded. Grouped
  logs and top IPs/countries/cities now read whole buckets from the CAGG and the
  partial head/tail straight from `geo_events`, so they match an exact raw scan.
- Fixed stacking of the moving point pulse.
- Live map packets now complete their route before coalesced follow-up traffic
  from the same visual corridor begins.
  - Analytics page: Bandwidth card fix - Decimal-as-JSON-string was capping the Y-axis; now coerced to int.
- Sidebar tooltips no longer appear as a side effect of collapsing the sidebar,
  and each navigation item now owns only one tooltip.
- Heatmap ↔ markers toggle bug: Re-key the GeoJSON <Source> so MapLibre recreates it with the correct cluster setting; points regroup correctly on switch.
- Fix bad mobile UI on the map page.
- CAGG refreshes now retry instead of silently skipping the range when a
  background refresh policy job runs concurrently.
- Database credentials containing reserved URL characters (`@`, `:`, `/`, `%`)
  no longer produce a broken connection URL.
- Geo-logs embedded map zoom control no longer floats mid-card on mobile; app shell sizes to the real visible viewport (dvh) so the map page fits even with the degraded banner; bottom drawers respect the iOS safe area.
- Mobile map controls moved from a floating button over the map into the top header bar (same icon as the desktop panel toggle); the auto-refresh dropdown got its own Timer icon and the theme toggle now matches the other header buttons' touch size.
- Access Logs History/Live tail switch now uses the same tab list style as the Top Countries/Cities card on Geo Logs.

### Added

- PWA support: app icons and favicon, web app manifest, an auto-updating service worker (app shell only; live data and auth are never cached), and an offline indicator.
- Access-logs and debug-logs filters collapse into a bottom-sheet Filters drawer on mobile.
- Debug Logs page at `/debug-logs`: raw and malformed log lines with stat cards
  (total, malformed, most common parse error), a filterable and sortable
  paginated table, and a row detail dialog with the copyable raw line, the parse
  error and the request's access-log context. Search covers the raw line and the
  parse error; IP, country, city and a malformed-only toggle narrow the table,
  and all filters live in the URL.
- New `/api/v1/access-log-debug` list and stats endpoints backing the page.
- `access_log_debug` now stores the linked request's context (timestamp, IP,
  method, URL, host, status, country, city, user agent) on the row itself,
  written at ingestion. The Debug Logs list filters, sorts and renders entirely
  from these columns, so it never queries the `access_logs` hypertable. Applied
  by migration `b7d41e9c2a30`, which also backfills existing rows and runs
  automatically at startup. Geo values are a snapshot taken at ingestion, so
  they do not move if a later GeoIP database update changes an IP's location.
- New `ip_location_hourly_stats` CAGG, so per-IP geo queries on 24h-30d ranges
  use hourly buckets like the other CAGGs instead of falling back to daily ones.
  Created at startup and its history materialized by `backfill_cagg_gaps`; no
  migration needed.
- Geo Logs page: geo events grouped by (location, IP) with counts, an
  embedded marker/cluster map, stat cards with previous-period trends, an
  events/unique-IPs time-series chart, and Top IPs / Countries / Cities lists.
  Country, city, IP include/exclude and hostname filters apply to everything on
  the page and live in the URL, so filtered views are shareable links.
- New `/api/v1/geo-events` endpoints backing the Geo Logs page: grouped logs,
  summary, time-series, top-ips/countries/cities and facets, with CAGG-backed
  fast paths for long ranges. The geojson endpoint now accepts optional IP
  include/exclude and hostname filters.
- Add search and filter options to access logs.
- Add more columns on the live tail access log view.
- Analytics page: Selectable chart granularity - Auto / Hourly / Daily selector; never RAW above 24h, falls back to get_stats_granularity, avoids hourly buckets on ranges above 7d.
- Analytics page: Added Top IPs and Top Countries / Cities cards (new API endpoints + tables).
- Added custom absolute date-range picker (mobile-friendly)
- Analytics page: Country / City / IP filters (multi-select + manual IP entry) wired to all charts and top-lists.
- Added CAGG gap backfill - recovers history that predates refresh coverage so charts and top-lists agree.
- Sidebar footer now reports the installed package version and indicates when
  the app is running in a container, including the release image tag.
- Added `react-icons`
- Settings section at `/settings`: Environment (all runtime settings with env
  vars, defaults and override highlighting; secrets hidden), Scheduler
  (background jobs with status, last run, duration and a "Run now" button)
  and About (app, runtime, database and GeoIP info).
- New `/api/v1/system` endpoints backing the Settings section.
- Data tables start with a compact column set on mobile; all columns remain available from the Columns menu.

### Changed

- Secret settings (`DB_PASSWORD`, `MAXMINDDB_LICENSE_KEY`,
  `APP_ADMIN_PASSWORD`) can no longer serialize into API responses or logs.

### Removed

- Unused settings: `SCHEDULER_DAILY_ROLLUP_HOUR`, `SCHEDULER_DAILY_ROLLUP_MINUTE`,
  `ANALYTICS_TOP_IPS_LIMIT`, `ANALYTICS_TOP_URLS_LIMIT`.


## [0.2.1] - 2026-07-13

### Fixed

- Live map route effects now coalesce nearby concurrent origins into visual
  corridors, preventing overlapping pulses from building up into thick,
  distracting route lines.

## [0.2.0] - 2026-07-13

### Added

- Animated network routes for live geo events: a glowing packet
  travels from each request origin to the server's configured map home, with
  an origin wave, route trail, and destination beacon.
- Map-home discovery from the server's external IP address, using the local
  GeoLite2 database. `MAP_HOME_LATITUDE` / `MAP_HOME_LONGITUDE` provide a
  manual override, and automatic discovery can be disabled when needed.
- Development-only map traffic harness: use `/map?demoTraffic=1` for a
  steady route stream or `/map?demoTraffic=burst` for concurrent routes.
- Per-browser controls to enable or disable route effects and switch between
  flat Mercator and interactive globe projections; both preferences persist
  locally.

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

[Unreleased]: https://github.com/GilbN/geometrikks/compare/v0.4.3...HEAD
[0.1.0]: https://github.com/GilbN/geometrikks/compare/v0.1.0-alpha.1...v0.1.0
[0.1.0-alpha.1]: https://github.com/GilbN/geometrikks/releases/tag/v0.1.0-alpha.1
[0.2.0]: https://github.com/GilbN/geometrikks/releases/tag/v0.2.0
[0.2.1]: https://github.com/GilbN/geometrikks/releases/tag/v0.2.1
[0.3.0]: https://github.com/GilbN/geometrikks/releases/tag/v0.3.0
[0.4.0]: https://github.com/GilbN/geometrikks/releases/tag/v0.4.0
[0.4.1]: https://github.com/GilbN/geometrikks/releases/tag/v0.4.1
[0.4.2]: https://github.com/GilbN/geometrikks/releases/tag/v0.4.2
[0.4.3]: https://github.com/GilbN/geometrikks/releases/tag/v0.4.3
