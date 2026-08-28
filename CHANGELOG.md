# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Response-time cards and the latency chart read "n/a" when the selected range has no measured requests, and "From N% of requests" when only some rows carry a timing. Top URLs and the access-log table show "n/a" for rows without one.
- `litestar backfill-timings` clears the placeholder 0.0 response time on rows imported from `combined`-format nginx archives. `--hostname` and `--before` narrow which rows it touches.

### Changed

- A missing `request_time` is now NULL instead of 0.0, so unmeasured requests stop dragging the response-time average and percentiles toward zero. The summary and URL aggregates gain a count of measured rows. The first start after upgrading adds that column in place and refreshes those four aggregates over the raw retention window; on a large database this takes minutes, and no history is lost. Buckets older than the window keep their pre-upgrade figures, which counted every row, because the raw rows needed to recount them are gone.
- nginx status 408, 444 and 499 no longer mark a request as malformed. A 444 is usually a block rule and a 499 is a client that hung up, so those lines now land in Access logs like any other request instead of filling the Debug page and the malformed count. Probe detection is unchanged; TLS, SSH and SMB handshakes and requests without a valid HTTP method are still flagged.
- Response-time figures (average, max, percentiles, and the Top URLs average) skip WebSocket connections (status 101) and connections that ended without a response (status 0). Their logged time covers the whole connection, not the response, and one open WebSocket was enough to put the Max Request Time card at 9000 s. The rows keep their duration in Access logs. The summary and URL aggregates gain filtered latency columns; the first start after upgrading adds them in place and refreshes those four aggregates over the raw retention window, the same way as the measured-row counts. The Top URLs column is labelled Path, which is what it shows.
- Top URLs lists one row per host and path. A path that several proxied hosts share, such as `/graphql` or `/favicon.ico`, used to show as one row with every host's hits summed; now each host gets its own row, with a Host column before Path. The first start after upgrading rebuilds the two URL aggregates over the raw retention window (minutes on a large database, `url_caggs_recreated` in the logs). Per-URL history older than that window cannot be rebuilt and is dropped; every other chart and card keeps its history.

### Fixed

- The Overview's Avg and Max Request Time cards formatted seconds as if they were milliseconds, showing a 40 ms average as 40μs.
- Stat cards on the Summary, Geo logs and Debug logs pages no longer read "Last Last month" or "Last Today" for calendar presets. Calendar ranges show their own name, and trends on the Summary page read "vs previous period" instead of "vs last Yesterday".
- The map basemap follows the System theme. It stayed dark while the rest of the app switched to light with the OS, and now switches with it, live.

## [0.11.0] - 2026-08-27

### Added

- Login, the error page, 404 and the Settings backdrop use the brand map scene (graticule, relief, markers, routes), and the map page shows it while the map loads. Backdrops render at the screen's native resolution, so they stay sharp on hi-dpi displays.
- Settings > Status: each site home shows the last day its source recorded traffic, and a retired source's auto-detected home can be removed so its beacon leaves the map. Homes pinned by `MAP_HOME_LOCATIONS` stay read-only. Backed by `DELETE /api/v1/geo-locations/site-homes/{hostname}` and a `lastEventDay` field on the site-homes response.
- Filters on Access logs, Geo logs, Debug logs and Analytics share one layout: text inputs on one row, selects on the next, include and exclude for the same field (IP, host, hostname) as one joined control, and a Clear button that shows how many filter groups are active. Geo logs and Analytics get the mobile filter drawer Access logs already had.
- Access logs: selecting a row opens the full record in a side panel, with ASN, recording hostname, source format and the ban controls. Enter and Space open rows too.
- Geo logs: selecting a row opens the full location record, ban controls included. Top IPs, Top locations and the event chart are framed cards with counts.
- Debug logs: the record detail is a side panel instead of a dialog, showing the raw line, the parse result and the linked request.
- Analytics charts name what they plot and the bucket size the range resolved to (Hourly or Daily), and offer a retry when a series fails to load.
- Map controls are one panel with labeled sections (Visualization, Live, Filters, Summary, Top IPs). Toggles are switch rows so the panel fits a laptop screen without scrolling, the map filters get a Clear, fit and home moved into the panel header, and the collapsed button shows a dot while filters are active. The live feed scrolls inside a bounded card instead of stretching to the map's height.
- Settings > Appearance: theme (System, Light, Dark) and accent (teal, green, copper) side by side with previews. System follows the device's color scheme live, not only at page load. The accent is also switchable from the header, persists per browser and is applied before first paint.
- Open Graph and Twitter card tags on the app shell.
- `geometrikks-json`, a keyed JSON access-log format for nginx (`log_format ... escape=json`) and the recommended nginx setup. Lines decode against a fixed schema instead of a positional regex, so a broken or mistyped format is rejected rather than mapped to the wrong columns. Works with live tailing, `LOGPARSER_LOG_FORMATS` and `import-logs --format geometrikks-json`. The existing nginx format keeps working.

### Changed

- New logo, wordmark, icons and color themes (dark "Aurora night", light "Fjord mist").
- Refactored the Settings pages.
- Tables, stat cards and data panels use one set of labels, borders and shadows across every page, and each page has a one-line description under its title.
- Map popups and controls follow the active theme and accent.

### Removed

- Five unused frontend dependencies: `@tanstack/react-table`, `@radix-ui/react-slot`, `@vite-pwa/assets-generator`, `baseline-browser-mapping` and `caniuse-lite`. Nothing imported them; the browserslist data pins never reached `browserslist`, which resolves its own nested copies.

### Fixed

- `scripts/generate-brand-assets.mjs` imports `playwright` directly, so it is now declared in devDependencies instead of resolving through the copy `@playwright/test` pulls in.
- Percent and ratio placeholders render as "-", matching every other empty cell.
- Stat card trend badges no longer pair a 0.0% label with an up or down arrow; tiny and non-finite deltas render as flat or hidden.
- Live tail: the Status column is wide enough for its header, which ran into Method.
- Ingestion reloads its GeoIP readers after the weekly GeoLite2 refresh replaces the database files, so new geo data applies without a restart. This also picks up files replaced outside the app (for example by `geoipupdate`), and a start in geo-degraded mode recovers on its own once a later scheduled download succeeds. Running the refresh job from Settings downloads fresh databases even when the current files are younger than `GEOIP_REFRESH_DAYS`, and applies a file replaced outside the app immediately.

## [0.10.0] - 2026-08-22

### Added

- ASN enrichment. Every ingested request records the autonomous system
  number and organization from the MaxMind GeoLite2 ASN database, which
  downloads and refreshes with the same credentials as the City database
  (`GEOIP_ASN_ENABLED=false` opts out). Missing credentials or a failed
  download never block ingestion; those rows carry no ASN data.
- Live map popups show the ASN behind each request, and the access-logs
  table gains ASN and AS organization columns in the column picker.
- Settings > Status warns when ASN enrichment is enabled but the GeoLite2
  ASN database is missing or failed to download, and `/health` reports the
  ASN database's availability and build date. Settings > About shows both
  GeoLite2 editions (build date, age, path), the Status GeoIP card lists
  both build dates, and the settings tree reports ASN availability.
- Analytics gains a Top ASNs view: a Traffic origin card with the exact
  hosting-vs-other split for the selected range, and a Top ASNs table
  (organization, ASN, category, hits, bytes), backed by per-ASN continuous
  aggregates and `GET /api/v1/analytics/top-asns`. Hosting tagging uses a
  bundled hosting-ASN list (the MIT-licensed brianhama/bad-asn-list)
  applied at read time, so list updates apply to all history. Unlisted
  networks read as Other, never residential.
- An info tooltip on the analytics views says how hosting classification
  works. Settings > About links the bundled list to its upstream source,
  carries the MaxMind GeoLite2 attribution, and opens the full list in a
  searchable dialog backed by `GET /api/v1/system/asn-classification`.
- The Summary dashboard gains a Traffic origin section with the hosting
  share of classified traffic and the busiest network for the selected
  range. It is hidden when no requests in range carry ASN data.
- The Top URLs and Top user agents tables sit side by side on wide screens.
- `litestar backfill-asn` stamps ASN data onto rows ingested before the
  feature existed or while the database was missing. It asks for
  confirmation, decompresses compressed history first, resolves and writes
  IPs in bounded chunks, and refreshes the ASN aggregates so the Top ASNs
  view picks up the backfilled range. A failed aggregate refresh exits
  non-zero.

### Fixed

- The Columns picker on the Access Logs, Geo Logs, and Debug Logs tables
  remembers its selection across reloads, per browser. Only columns you
  toggled are stored, so the rest keep their defaults and columns added in
  later releases appear as intended. A "Reset to defaults" item clears
  the saved selection. The picker is now wide enough for its labels
  instead of wrapping them at the width of the Columns button.
- The Summary dashboard shows placeholder cards for every section while
  loading, so sections no longer pop in and shift the page, and it fetches
  the Traffic origin data at the same time as the summary instead of after
  it.

## [0.9.0] - 2026-08-20

### Added

- `LOGPARSER_HOST_NAME` accepts a JSON list matched positionally to
  `LOGPARSER_LOG_PATHS`, so one instance tailing logs shipped from several
  machines records each file under its source hostname. `litestar
  import-logs` gained `--hostname` to set the stamped hostname per import
  and now echoes which hostname it stamps.
- `APP_MODE=agent`: run the same image as a lightweight remote agent that
  tails, geolocates, writes, and publishes to the live map, serving only
  `/health` and `/health/ready`. An agent reports not-ready until the
  primary's schema has arrived, so an orchestrator restarts it into a fresh
  wait rather than leaving it idle. `LOGPARSER_ENABLED=false` turns a full
  instance into a UI head with no local tailing, presented as an operator
  choice (a neutral "Ingestion off" state) rather than degraded health.
  The live-feed backend now reuses a persistent publish connection and
  reconnects its listener automatically.
- The map can filter by source hostname: a Sources control beside the
  country/city filters, URL-backed filter state (shareable links), live
  traffic and vitals restricted to the selected sources, and the source
  hostname shown on live popups and feed rows.
- Settings > Status shows generic operator advisories from the health
  endpoint. The first producer warns when the map's per-source aggregates
  are held back, either because the recorded hostnames look like Docker
  container IDs or because there are more of them than those aggregates are
  built for, and gives the consolidation command.
- Multi-site home locations: agents detect their own public-IP location and
  record it per hostname, with live map routes flying to each source's home
  (one beacon per site). `MAP_HOME_LOCATIONS` overrides any hostname's
  coordinates for sites whose public IP geolocates wrong or whose logs are
  shipped from another machine. Detection refreshes on its own
  `MAP_HOME_REFRESH_HOURS` cadence (default 24h). The `GET
  /api/v1/geo-locations/site-homes` endpoint serves each hostname's current
  home location plus the instance's default home for map rendering. Settings
  > Status now shows a "Site homes" block listing each hostname's
  coordinates and whether they came from auto-detection or an override, so
  a CGNAT-mismapped source is visible in-app.
- `dev/`: a committed local multi-source test harness: `docker compose -f
  dev/docker-compose.agents.yml --env-file .env up --build` starts a
  dedicated TimescaleDB, a UI head, two agents (nginx + traefik formats),
  and a log injector feeding them synthetic live traffic for as long as
  the stack is up.

### Changed

- The live map feed (`/ws/live`) now fans out through PostgreSQL
  LISTEN/NOTIFY, so committed traffic from any writer process reaches the
  map, and live events carry the source hostname. Batch imports no longer
  feed the live map.
- The map layer choice and Live toggle now persist across visits.
- The location aggregates are rebuilt once at startup with a per-hostname
  dimension so source-filtered maps stay fast. History older than the raw
  retention window (default 180 days) cannot be rebuilt and is discarded at
  that upgrade; installs with many container-ID hostnames skip the rebuild
  until consolidated (see the status page advisory).

### Fixed

- The compose files size the TimescaleDB worker pool for the app's ~32
  background jobs (`timescaledb.max_background_workers=40`,
  `max_worker_processes=51`), stopping the periodic "failed to launch job
  ... out of background workers" warnings when the aggregate refresh
  policies all fire at once. Existing installs: copy the `command:` block
  from `docker-compose.yml` onto the database service and recreate it.
- `docker-compose.yml` sets `stop_grace_period: 20s` on the app service, as
  the deployment docs already prescribed. Docker's default 10s stop timeout
  raced Granian's 15s worker-kill timeout, so `docker stop` could SIGKILL
  the container mid-teardown and lose the ingestion batch still in flight.
  Existing installs: add the same line to your app (and agent) services.

## [0.8.0] - 2026-08-16

### Added

- Traefik JSON access log support with per-file format auto-detection
  (`LOGPARSER_LOG_FORMATS`), and a `--format` option on `litestar import-logs`.
- `hostname` and `log_format` columns on access logs, with new facet filters
  (recording hostname, source format) on the access-logs page.
- `litestar backfill-hostname` CLI command to set the recording hostname on
  historical rows; `--consolidate` collapses accumulated hostnames (e.g. container id hostnames).

### Changed

- Log files UI (/settings/logs): the `nginx` kind is now `access` with proxy-neutral labels;
  bookmarked download links containing `/nginx/` change (/api/v1/logs/files/access/access.log).
- docker-compose: `ACCESS_LOG_DIR` is the preferred mount variable
  (`NGINX_LOG_DIR` still works); the app container has a stable hostname.
- **Breaking:** the access-log mount inside the container moved from
  `/var/log/nginx` to the proxy-neutral `/var/log/access`, and the
  `LOGPARSER_LOG_PATHS` default is now `/var/log/access/access.log`. If your
  `.env` sets `LOGPARSER_LOG_PATHS` with `/var/log/nginx/...` paths, change
  them to `/var/log/access/...` when upgrading the compose file.


### Fixed

- The access-log `url` and `referrer` columns were historically swapped
  (URL showed the Referer header, Referrer showed the request path); a
  migration corrects existing data and rebuilds the Top URLs aggregates.
  The migration decompresses compressed `access_logs` chunks to do it, so
  disk usage grows for a while until the compression policy recompresses
  them.
- Concurrent GeoMetrikks instances sharing one database no longer drop an
  ingestion batch when racing to create the same geo location.

## [0.7.1] - 2026-08-11

### Added

- Time-series charts (requests, bandwidth, latency, status classes, geo events)
  now auto-clamp the y-axis when a single traffic burst dwarfs the rest of the
  range, keeping normal traffic readable. Clamped charts show a
  "y-axis clipped at ..." note in the card header; spike buckets clip at the
  top edge and tooltips keep the true values.
- Settings > Status has an Authentication card reporting whether the built-in
  authentication is active.
- `/logout` is now a route of its own, not only a sidebar button.

### Changed

- `GET /api/v1/auth/me` now reports an auth mode: `{"mode": "session",
  "username": "..."}` when logged in, `{"mode": "disabled"}` when
  `APP_AUTH_DISABLED=true`. In that mode a valid `POST /api/v1/auth/login`
  returns the same disabled payload without establishing a session, and
  `POST /api/v1/auth/logout` returns 204 without touching one.
- 404 and 401 responses now log a single `client_error` warning instead of an
  error-level traceback. Debug mode keeps the full traceback.

### Fixed

- Selecting "Today" (or any range not starting at UTC midnight) with daily
  granularity no longer renders an extra full day in the charts. The frontend
  now sends the browser's timezone as a new optional `tz` query parameter on
  the time-series endpoints, and daily buckets are computed as local days in
  that zone for ranges up to 30 days (rolled up from hourly data: counts
  summed, latency sketches and unique-count HLLs merged). Ranges beyond 30
  days keep UTC day buckets, since only the daily aggregates reach that far
  back.
- The status-classes chart no longer renders near-invisible bars on dense
  views such as 7d+ with hourly granularity: past 48 buckets it switches to a
  stacked area chart with the same colors and stack order. The card-colored
  spacer strokes between bar segments were wider than the sub-pixel bars
  themselves, erasing the fill entirely.
- Chart tooltips now show the bucket time in the browser's timezone instead of
  the raw UTC ISO string, matching the X axis ticks. Affected the requests,
  bandwidth, latency, status-class and geo-events charts.
- The Summary page's date-range badge now shows the range in the browser's
  timezone with a matching zone label instead of hardcoded UTC; hovering it
  still shows the full UTC instant.
- With `APP_AUTH_DISABLED=true` the auth endpoints stay registered, so the
  frontend's `/api/v1/auth/me` call no longer 404s into an uncaught-exception
  traceback on every page load. `/login` and `/logout` redirect to the
  dashboard in that mode instead of rendering a form that cannot work.

## [0.7.0] - 2026-08-02

### Added

- `GEOMETRIKKS_ENV_FILE` environment variable to override the `.env` file
  path; an empty value disables dotenv loading entirely (the test suite uses
  this so results never depend on a local `.env`).
- `DB_MIGRATE_ON_STARTUP` setting (default `true`). Set to `false` to run
  schema migrations as a separate deployment step with
  `litestar database upgrade` instead of at every app startup; the app then
  fails startup deliberately if the schema was left unusable.
- `docs/deployment.md` documenting the container runtime model, the
  single-worker constraint, migration ownership, shutdown behavior, and
  health endpoints.

### Fixed

- Fixed horizontal page scrolling on mobile Settings routes and replaced the
  overflowing tab row with a compact section selector.
- `docker stop` now shuts the server down gracefully: ingestion drains its
  current batch and the scheduler stops before the process exits. The
  container previously killed the server without running any teardown
  because the CLI wrapper did not forward SIGTERM to Granian; the server
  now runs in Granian's direct process mode under a tini init.
- Shutdown is no longer delayed when a log file is missing or has not yet
  received a parseable line. The tailer's waits now end as soon as a stop is
  requested, instead of occupying a worker thread for up to 60 seconds and
  leaving the container to be force-killed part-way through teardown. This
  was reachable on a fresh install, where nginx has created the access log
  but not yet written to it.

### Changed

- **Breaking:** all REST API JSON fields and query parameters are now
  camelCase (`totalRequests`, `startedAt`, `fromTimestamp`, `startDate`,
  `comparePrevious`, ...); previously the dataclass-backed endpoints
  (analytics, system, settings, stats, health, CrowdSec, geo top-IPs/GeoJSON,
  log files) used snake_case. Digit-adjacent fields are `status2xx`-style and
  `requestCount24h`. Path segments (`{location_id}`, `{job_id}`), WebSocket
  frame payloads, `orderBy` column values, and the error envelope are
  unchanged. External API consumers must rename fields; the bundled frontend
  is already migrated. The full policy is documented in
  `docs/api-conventions.md`.
- Errors on API paths that previously returned an empty 404 body (unknown
  routes, CrowdSec-disabled lookups) now return the standard
  `{status_code, detail}` JSON envelope; non-API 404s are unchanged.
- All REST endpoints are mounted through a single versioned `/api/v1` router;
  URLs, operation IDs, and generated client method names are unchanged.
- Application startup and shutdown are now composed of focused lifespan
  phases (core state, GeoIP, CrowdSec, database, scheduler, ingestion), each
  owning its own cleanup. A failure during startup now stops the services
  that had already started instead of leaking them; teardown order and the
  DB-degraded and geo-degraded behaviors are unchanged.
- `create_app()` accepts an explicit settings object and app-level dependency
  overrides, and request handlers now receive settings through dependency
  injection instead of resolving the process-cached factory inline. The
  SQLAlchemy engine, startup migrations, scheduled aggregate jobs, and
  trusted-proxy client-IP resolution all bind to the composed settings; the
  `settings` dependency name is reserved (overriding it would split
  configuration between request handlers and the rest of the app).
- The backend test suite runs async tests on AnyIO (pytest-asyncio removed),
  is fully isolated from `.env` and ambient environment values, and gained
  WebSocket feed coverage for degraded-mode 1013 closures, overflow/drop
  counting, heartbeats, unsubscribe cleanup, cancellation, the session-auth
  handshake boundary, and the inbound-frame policy.

- Development now runs on a single origin: `litestar run` serves the app,
  all Vite assets, and hot-module reload through `http://localhost:8000`
  (the Vite sidecar uses an internal ephemeral port). The standalone Vite
  dev server on :5173, its `/api` and `/ws` proxies, and the published 5173
  port in the dev compose are gone.
- The production image installs the application as a built wheel instead of
  copying the source tree, runs a single explicit Granian worker, and uses
  tini as PID 1. litestar-vite upgraded to 0.29 on both the Python and npm
  sides.
- The `/health`, `/health/ready`, `/api/v1/stats`, and `/api/v1/logs/tail`
  responses now have typed OpenAPI schemas (readiness documents its 503
  response); payload shapes on the wire are unchanged.
- The geo-locations API is served through a dedicated service layer with
  Advanced Alchemy pagination; the `currentPage`/`pageSize` parameters and
  default page size are unchanged.
- Invalid filter, sort, and ban-duration values are now translated to 400
  responses centrally from domain exceptions instead of per-controller HTTP
  raises; the `{status_code, detail}` error envelope is unchanged.
- All API query and path parameters now use Litestar's explicit
  `QueryParameter`/`FromPath` declarations (Litestar 3.0 readiness). Wire
  names and validation are unchanged; the OpenAPI schema gains descriptions
  for the two `/logs/tail` query parameters.
- The `DB_POOL_PRE_PING` setting is now honored; it was previously declared
  but hardcoded to enabled.
- The `VITE_USE_SERVER_LIFESPAN` and `VITE_ENABLE_REACT_HELPERS` settings are
  now passed through to the Vite integration; they previously had no effect.
- Litestar is now constrained to the 2.x series (`<3`) so the upcoming
  Litestar 3.0 release cannot be picked up accidentally before the planned
  migration.
- The test suite now fails on new Litestar deprecation warnings and runtime
  warnings, with the seven known upstream advanced-alchemy filter-provider
  warnings pinned as the only deprecation exemption.

### Removed

- The `VITE_HOT_RELOAD` setting, which mapped to nothing in the Vite
  integration (HMR is always on in dev mode).
- Dead internal dependency providers (`transaction`, access-log repository)
  and the unused `litestar-mcp` dev dependency.

## [0.6.0] - 2026-07-31

### Added

- Settings gained a Status tab (now the first tab) showing per-component
  health: overall status with app uptime, ingestion state with
  parse/skip/pending counters, a last-event-ingested freshness signal and
  the tailed nginx access logs (flagging missing files), database
  reachability, GeoIP database availability with database age and next
  scheduled refresh, CrowdSec LAPI reachability with the active decision
  count, a scheduler job snapshot, live feed connectivity, and a recent
  errors panel from the application log. The sidebar health indicator now
  links to it, so a "Degraded" state is explainable in one click.
  (/health gained nullable started_at, ingestion.last_record_at and
  geoip.db_modified_at fields to support this.)
- The Status page Database card shows database size, PostgreSQL and
  TimescaleDB versions, retention windows, per-hypertable approximate row
  counts and sizes, and the overall compression ratio, served by a new
  `GET /api/v1/system/database` endpoint backed by fast TimescaleDB catalog
  queries.
- Debug Logs and Geo Logs tables now show the Banned badge and ban/unban
  controls next to IP addresses, matching Access Logs and Alert History.
  The debug-line detail dialog shows them on its IP row as well.
- The Geo Events by Location and IP table can now be sorted by any column
  except Hostnames, matching Access Logs: click a header to sort, click again
  to flip direction. IPs sort in numeric address order, empty values always
  sink to the bottom, and the sort is part of the shareable URL. On ranges
  over 24 hours, sorting by Last seen orders to day precision.
- The Geo Events by Location and IP table gained a Last seen column showing
  each (location, IP) pair's most recent event (day-granular on ranges over
  24 hours).
- The Security page now shows a warning banner while the CrowdSec LAPI is
  unreachable and keeps the last known decisions and alerts visible instead
  of hanging on loading skeletons. Reachability changes are pushed live over
  the CrowdSec WebSocket feed, reported in /health, and flagged with a
  warning dot on the Security sidebar item.
- Ban and unban actions now show an error toast when they fail (for example
  while the LAPI is down) instead of failing silently.

### Changed

- Map popup ban buttons (location top-IPs and live-request popups) now open
  the same duration dropdown as the log tables instead of immediately banning
  with the default duration; unbanning asks for confirmation via the menu.

- Analytics top lists (URLs, user agents, IPs, countries, cities) are now
  served from continuous aggregates on ranges over 24 hours instead of
  scanning raw access logs, making long-range views much faster. The IP,
  country and city lists stay on the fast path even with country/city/IP
  filters; filtered URL and user-agent lists still scan raw logs.
- Geo Logs summary and chart stay on the fast aggregate path when filtered
  by country, city or IP on ranges over 24 hours. Hostname filters still
  scan raw events.
- Access Logs country, city and host filter dropdowns, and the Geo Logs
  hostname dropdown, load from aggregates instead of scanning the full log
  history, and now list values from all recorded history rather than only
  the raw retention window.

### Fixed

- Deleting a tailed log file while the app is running no longer logs a
  "Could not stat log file" warning every second forever while /health keeps
  reporting healthy. The disappearance is now logged once as an error, /health
  reports the missing paths (ingestion.missing_files) with status degraded,
  the sidebar indicator and the Status page show the condition, and tailing
  still resumes automatically when the file reappears (log rotation included).
  A file vanishing at the exact moment a line was read also no longer kills
  the tail task.
- /health no longer reports ingestion as running (and overall status as
  healthy) when every tailed log file is missing: once all tail tasks have
  given up waiting for their files, the ingestion service now shuts down and
  health reports ingestion.running false with status degraded.
- Map top-IP lists (global and per-location) no longer include events from
  outside the selected range on ranges over 24 hours: the window was
  previously floored to whole days, over-counting the partial first day.
- Geo Logs chart on ranges up to 24 hours no longer includes events from just
  before the selected window in its first data point, and its unique-IP counts
  on those short ranges are exact instead of estimated.
- Geo Logs grouped rows and top lists on ranges over 24 hours no longer
  scan the entire raw event history while stitching partial-bucket window
  edges: TimescaleDB can now skip time chunks outside the selected range.
  On a database with 18M rows these queries dropped from seconds to tens
  of milliseconds.
- Top lists across Analytics, Geo Logs and the map order rows with equal
  counts deterministically (alphabetical within a tie), so tied entries no
  longer shuffle between refreshes.
- Startup no longer re-backfills hourly aggregate history on every restart.
  The gap check now respects hourly aggregate retention, so buckets that
  retention already dropped on purpose are no longer treated as missing and
  rebuilt, only to be dropped again by the next retention run.
- Debug Logs: the "Copy" button in the line-detail dialog did nothing when
  GeoMetrikks was reached over plain HTTP on a LAN address. Browsers only
  expose the clipboard API to HTTPS and loopback origins, so copying now
  falls back to a hidden-textarea copy, and reports "Copy failed" instead of
  silently doing nothing when even that is refused.
- Logging in no longer intermittently bounces straight back to the login
  page. Session handling now applies only to `/api` and `/ws`: previously
  every static-asset response also rewrote the session it had loaded, so an
  asset request still in flight during login (the PWA precaches many at once)
  could overwrite the fresh session with stale logged-out data and the next
  API call would 401.
- A failing CrowdSec stats request no longer hides the entire Security stat
  card row behind permanent loading skeletons, and the decisions table no
  longer claims "No active decisions" when the decision list could not be
  fetched.
- /api/v1/crowdsec/status no longer performs a live LAPI probe on every
  request (which could block for the full request timeout); it reads the
  stream poller's cached reachability instead.

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

[Unreleased]: https://github.com/GilbN/geometrikks/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/GilbN/geometrikks/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/GilbN/geometrikks/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/GilbN/geometrikks/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/GilbN/geometrikks/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/GilbN/geometrikks/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/GilbN/geometrikks/releases/tag/v0.7.0
[0.6.0]: https://github.com/GilbN/geometrikks/releases/tag/v0.6.0
[0.5.0]: https://github.com/GilbN/geometrikks/releases/tag/v0.5.0
[0.4.3]: https://github.com/GilbN/geometrikks/releases/tag/v0.4.3
[0.4.2]: https://github.com/GilbN/geometrikks/releases/tag/v0.4.2
[0.4.1]: https://github.com/GilbN/geometrikks/releases/tag/v0.4.1
[0.4.0]: https://github.com/GilbN/geometrikks/releases/tag/v0.4.0
[0.3.0]: https://github.com/GilbN/geometrikks/releases/tag/v0.3.0
[0.2.1]: https://github.com/GilbN/geometrikks/releases/tag/v0.2.1
[0.2.0]: https://github.com/GilbN/geometrikks/releases/tag/v0.2.0
[0.1.0]: https://github.com/GilbN/geometrikks/compare/v0.1.0-alpha.1...v0.1.0
[0.1.0-alpha.1]: https://github.com/GilbN/geometrikks/releases/tag/v0.1.0-alpha.1
