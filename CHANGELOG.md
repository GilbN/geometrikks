# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `APP_SESSION_MAX_AGE_DAYS` sets how long a login lasts, 7 days by default. Raise it for a wall screen that nobody logs in to by hand.
- An open page now says when the server has been updated. On desktop the sidebar version turns into a card with a Reload button. On phones a toast offers Reload or Later and leaves a dot on the menu button. A page nobody has touched for 5 minutes reloads itself, so a wall screen moves to the new version without help.
- GeoMetrikks checks GitHub every 12 hours for a newer release. Settings > About announces it and the sidebar version gets a dot. Set `APP_UPDATE_CHECK=false` to turn the check off.

### Changed

- On a phone, Analytics and Geo Logs have a row of section buttons pinned under the top bar. Tap one to jump to that chart or list. The button for the section you're looking at lights up. Chart legends show two entries per line.
- On a phone, the stat cards on the Overview, Security, Geo Logs and Debug Logs pages sit two to a row and take less height, so the Overview is about half as long. The top bar already names the page, so the page title and description are hidden, as are the descriptions on table and chart cards. Access Logs puts its Filters button next to the History and Live tail tabs, and the Overview's date range leaves out the times when it spans more than a day.
- The Overview page heading says Overview, matching the menu, instead of Summary.
- Stat card titles and values line up across a row when one card's title wraps onto more lines.
- Settings > Logs draws only the lines on screen, so a full 2,000-line buffer scrolls smoothly. On a phone or in a narrow window each line takes two rows, with the level, component and time on top and up to two lines of the message below, and the list scrolls with the page. While you're scrolled down the list, new lines wait until you're back at the top, and a button over the list says how many and takes you there. Closing a line's details puts keyboard focus back on that line.
- When a top list on Analytics or Geo Logs is too narrow for its columns, as on a phone, the top IPs, URLs, user agents and networks show each entry on two lines. The name and its count sit on top, with the supporting numbers below. URLs and user agents wrap onto two lines instead of being cut off at one.
- On a phone or in a narrow window, Active decisions and Alert history on the Security page show each row on two lines. A decision has its IP and type on top, with the scenario and time left below. An alert has its scenario on top, with the time, outcome and IP below.
- Scenario names in the Security tables, the Top scenario card, the IP actions menu, the IP inspector and the banned-IP map popup leave out the `crowdsecurity/` prefix. Any other author stays next to the name, and a manual decision shows its reason only when you gave one. The alert details still show the full name.
- Active decisions, the alert details, the IP actions menu, the IP inspector and the banned-IP map popup show the time left as "3h 49m" or "6d 21h", and a decision that runs for years as "Forever", instead of CrowdSec's raw duration such as `86471h2m44s`.
- On a phone or in a narrow window, Access Logs, Geo Logs and Debug Logs show each row on two lines instead of a table you scroll sideways. On Access Logs the status, method and full URL sit on top, with the time, country and IP below. The list scrolls with the page rather than in a box of its own, and a Sort button opens a drawer to pick the field and the order.
- Live tail says it is waiting for requests until the first one arrives, instead of showing an empty table.
- On touch screens, buttons, tabs, menu and list rows, dropdowns and the map zoom and compass buttons are at least 40px, and table sort headers fill their header cell. Icon buttons inside table rows stay at 32px so the rows don't grow. Small links on Settings > Status and Settings > About get a larger tap area. With a mouse, sizes stay as they were.
- The info button next to the ASN categories on Analytics and Geo Logs opens its explanation on click or tap. It used to need a hover, which a phone can't do.
- IP columns in the log, analytics and security tables have a copy button and one actions menu in place of the inspect, fly-to and ban buttons. The menu inspects the IP, flies to it, bans or unbans it, and adds the row's IP, host, server, country or ASN to the page's filters or takes it out again. Its header shows the IP's decision with the scenario and time left, plus the IP's location and network. On phones the menu opens as a bottom drawer. An IP with an active CrowdSec decision takes the decision's colour instead of carrying a Banned badge.
- On phones and narrow windows, Settings > Scheduler lists each task with its schedule in plain words ("Every 15 seconds"), when it last ran, how long that took, when it runs next and a run button. When the last run failed, the error sits under the task, and tapping it shows the full text. On desktop it lives in a tooltip, which a touch screen can't open.
- The top card on Settings > About leads with the running version. A newer release appears as the next step on a short track, with a link to its release notes. If you are more than one release behind, the track says how many you would skip and links to the full release list. The card no longer breaks the version across lines on phones, and it shows the container image tag only when it differs from the version.
- Selecting text in a table row no longer opens the row's details, so you can highlight an IP or URL and copy it straight from the table.
- A new version no longer reloads a page you are using without warning. The page shows the notice first. It reloads by itself only after 5 minutes with no input, or when you come back to a tab that was in the background during the update.
- While the database is down, the login page says so, and a failed sign-in explains why instead of saying "Invalid username or password". A logout that fails now says so and keeps you on the page.
- Logins survive restarts and updates. Updating to this release logs you out once, because sessions used to live only in memory. Changing the admin user or password, or who may sign in with OIDC, still logs everyone out on the next start.
- Dev images and source checkouts report the version they were built from, such as v0.22.0-dev.4, instead of the last stable release. A build without a version, such as a plain `docker build`, shows "local build". The agents page no longer warns about version differences when either side is a local build.
- The OpenAPI schema at `/schema` reports the API version, 1, instead of the app version.
- Settings > Agents shows the Name row in an instance's details only when `APP_INSTANCE_NAME` isn't set. An instance with a configured name no longer shows "set by APP_INSTANCE_NAME".
- `docs/configuration.md` lists the settings for working on GeoMetrikks itself in a Developer settings section at the end: `APP_DEBUG`, `APP_ENVIRONMENT`, the SQL echo and pool switches, `DB_DROP_ON_STARTUP`, `LOGPARSER_SKIP_VALIDATION`, `SCHEDULER_LOCATION_REFRESH_INTERVAL_MINUTES` and the Vite settings.

### Fixed

- Pages on a phone no longer show the desktop filter bar for a moment while they load.
- Settings > Environment wraps long list and map values, such as a full `APP_TRUSTED_PROXIES` or `MAP_SERVER_LOCATIONS`, between their items. A long value used to run off the side of the page and squeeze its description to one word per line.
- The top bar on Settings > Appearance and Settings > Changelog shows the page name instead of "Page".
- Settings > Environment shows one Application group. It listed two groups with that name, and the second one's shortcut jumped to the first.
- Settings > Status says "Attention" when advisories or agents need attention, like the sidebar does. It used to say "Healthy, All components operational" right above the list of problems.
- The malformed share on Debug Logs reads "100.0% of total" instead of "+100.0% of total".
- The Columns menu on Access Logs, Geo Logs and Debug Logs uses the height left on screen instead of stopping at 320px, so it lists more columns before you have to scroll it.
- A grouped decision on the Security page counts its scenarios, not its decisions. An IP with 28 decisions from 6 scenarios said "28 scenarios". When every decision comes from one scenario, the row shows that scenario.

### Removed

- `API_HOST` and `API_PORT`. The server never read them. It listens on the host and port given to `litestar run`, which is `0.0.0.0:8000` in the image.
- `API_LOG_LEVEL`, deprecated since 0.5.0. Set `LOG_LEVEL` instead.
- `GEOIP_VALIDATE_DB_PATH` and `GEOIP_VALIDATE_LOCALES`. A missing GeoLite2 file still starts the app in geo-degraded mode, and an unsupported `GEOIP_LOCALES` value always fails startup.
- `APP_VERSION`. The version shown in the UI and the API schema always comes from the installed package.
- `APP_NAME` and `APP_DESCRIPTION`. They only set the API schema's title and description.
- `VITE_ENABLE_REACT_HELPERS` and `VITE_EXECUTOR`. Dev mode always runs Vite through bun with React refresh on.

### Fixed

- Banned IPs on the Security page get their country and city from the GeoLite2 database when GeoMetrikks has no traffic from them. Bans from mail or SSH scenarios, and IPs last seen in the proxy logs more than 30 days ago, showed "-" in the Country column.
- Alert details and alert history show the full country name where CrowdSec sends only a code, such as "Netherlands" in place of "NL".
- The close button on a row's details and on the IP inspector sits in the middle of the header. On phones it sat about 10px below the title.

## [0.22.1] - 2026-10-25

### Fixed

- Upgrading from 0.20 or earlier no longer fails at startup with "permission denied for schema _timescaledb_internal" when GeoMetrikks connects as a role that isn't a PostgreSQL superuser, as on a native PostgreSQL install. The bundled TimescaleDB container was not affected.

## [0.22.0] - 2026-10-25

### Added

- The README's Traefik setup has a Pangolin section. It covers the fields to keep in Pangolin's access log and how to get the visitor's address in the log.
- Security > Alert history can be filtered by IP and by up to five scenarios. The Scenario dropdown lists the scenarios of the newest 500 alerts in the window with their counts, and the alert sheet has a "Show only this scenario" button. Back-to-back alerts of the same kind from one IP collapse into one row that expands. On phones the filters sit in a Filters drawer.

### Changed

- Security > Alert history shows the alert kinds as tabs with an explanation of each, and "Detections" is now "Log scenarios". An empty WAF or Bot detection view says what that kind needs.
- Security > Alert history shows the bans the bot challenge raises under Bot detection, marked "Bot ban". Rejected submissions are now marked "Bot rejected".
- Security > Alert history has an Outcome column that says what each alert did, such as "Ban, active" or "Alert only". The Banned badge next to the IP shows the IP's current state.
- Security > Alert history says which settings it needs when CrowdSec machine credentials are missing. Before, the Security page left the card out.

### Fixed

- AS8100 no longer gets the Hosting badge. It used to belong to QuadraNet and now belongs to Splice Internet, an Australian residential ISP.
- Security > Alert history stopped at 50 alerts. "Load older" now loads up to 1,000 alerts from the selected window. Filter by IP or scenario to go further back. The list stops refreshing while older alerts are loaded, and "Back to newest" returns to the latest alerts and turns refreshing back on.

### Security

- GeoMetrikks now requires Brotli 1.2.1, which fixes CVE-2026-111497. Brotli 1.2.0 and older can crash or run attacker code when they decode crafted data. GeoMetrikks decodes Brotli responses from the servers it calls, such as RDAP registries and the public IP lookup.
- GeoMetrikks now ships aiohttp 3.14.5 and certifi 2026.10.23. aiohttp 3.14.3 had request smuggling and resource exhaustion advisories, and the old certifi bundle still trusted emSign root CAs whose intermediate keys were compromised.

## [0.21.0] - 2026-10-18

### Added

- Themes. Settings > Appearance offers Aurora, Moss, Forge and Night, each with a light and a dark palette that follow Light, Dark or System. Pick one theme for both modes or mix them, such as Moss in light mode and Forge in dark mode. Night uses white and light grey in light mode and near-black in dark mode, with grey-scale buttons, links and logo.
- `import-logs` reads Nginx Proxy Manager's own per-host access logs with `--format npm`, and `--format auto` detects them. You can backfill the history from before you set up the JSON log. Imported NPM rows have no response times, protocol or remote user. Live tailing doesn't accept the format. `LOGPARSER_LOG_FORMATS=npm` fails at startup, and a tailed file in that format logs a warning that points to the JSON setup.
- `import-logs --before` leaves out lines stamped at or after a given date or time, so an import can stop where an already ingested log begins. Running a file again with a later `--before`, or none, imports only the lines in between.
- GeoMetrikks can read access logs from Grafana Loki instead of a file. Set `LOKI_URL` and `LOKI_QUERIES`, with one LogQL stream selector per source. Loki lines get the same format detection, parsing and GeoIP lookup as a tailed file. The Status page lists each Loki source, and `/health` lists one that can't be reached or that refuses the query under `ingestion.unavailableSources`. See "Loki setup" in the README.
- `import-loki` backfills history from Grafana Loki. `litestar import-loki --since 2026-09-01` reads that range of every `LOKI_QUERIES` selector with the same format detection, parsing and GeoIP lookup as live reading. Without `--before` it stops where the data already in the database begins. Rerun an interrupted import with the same range and it picks up at the last completed hour. The command refuses a range that overlaps an earlier import unless you pass `--force`. See "import-loki" in the README.
- Settings > Agents lists every agent writing to the database, with its version, servers, recent lines and failures, and when it last checked in. Click a row for that agent's ingestion, GeoIP, scheduled jobs, log sources and last error. You can remove an agent that has stopped checking in. An agent with a problem, such as one that stopped checking in, runs another version or can't read one of its logs, gets a card on Settings > Status and turns the sidebar status dot amber. Agents show up once they run this release. See "Multi-source setup" in the README.
- `APP_INSTANCE_NAME` names an instance on the Agents page. Set it on every agent. Unset, agents go by `agent` and the full instance by `head`, so two unnamed agents overwrite each other's status. The page flags an agent running under the default name and a name that more than one process uses.

### Changed

- Themes replace the accent color picker, which is gone from the header and from Settings. A saved teal, green or copper accent becomes Aurora, Moss or Forge. Moss and Forge now tint the page and panels to match their color.
- Settings > Appearance shows Light, Dark and System as preview cards drawn in the current theme.
- Tabs, switches, checkboxes, menu items and select options show the pointer cursor on hover, like buttons already did.
- In dark mode, menu and list highlights are a faint tint of the theme color instead of a solid fill, and primary buttons use a faint tint too.
- The Ban button in the Ban IP dialog and the Remove button in the server location confirmation are red. The dialog's Cancel button has a border like other secondary buttons.
- Dialogs blur the page behind them, as confirmation prompts already did.
- "Server" is now the one name for whatever recorded a request: a GeoMetrikks instance, a tailed file or a Loki selector. It replaces "hostname", "recorded by", "source" and "site home" across the UI. Access Logs has a Server filter and column. Geo Logs has a Server filter and a Servers column. The map has a Server filter, a Server markers toggle and "Go to server location". Settings > Status lists Server locations. Saved table column layouts carry over. If you had turned off the map's home markers, the Server markers toggle is on again after the upgrade.
- Six environment variables have new names. `LOGPARSER_HOST_NAME` is `LOGPARSER_SERVER_NAME`, `MAP_HOME_LOCATIONS` is `MAP_SERVER_LOCATIONS`, `MAP_HOME_LATITUDE` and `MAP_HOME_LONGITUDE` are `MAP_SERVER_LATITUDE` and `MAP_SERVER_LONGITUDE`, `MAP_AUTO_DETECT_HOME` is `MAP_AUTO_DETECT_SERVER_LOCATION`, and `MAP_HOME_REFRESH_HOURS` is `MAP_SERVER_LOCATION_REFRESH_HOURS`. The old names work until 1.0. A process that reads any old name shows a `legacy-env-names` advisory in its own `/health` and logs a warning at startup. The full instance's Settings > Status shows that advisory for its own settings, and Settings > Agents shows it on the row of each agent that reads an old name. If an old and a new name are set to different values, startup fails with an error naming both.
- `backfill-hostname` is now `backfill-server`, and `backfill-geo-hostnames` is now `backfill-geo-servers`. `import-logs` and `backfill-timings` take `--server` instead of `--hostname`.
- **Breaking:** the API and page URLs say server instead of hostname, so API scripts and bookmarks that use the old names need updating. Filters take `serverIn` and `serverNotIn` instead of `hostnameIn` and `hostnameNotIn`. Responses carry `server` and `servers` instead of `hostname` and `hostnames`, and `/ws/live` frames carry `server` instead of `hostname`. `/api/v1/geo-locations/site-homes` is now `/api/v1/geo-locations/server-locations`. Page URLs use `/access-logs?server=&serverx=`, `/geo-logs?server=` and `/map?server=`, and an old bookmark opens the page without its filter. The advisory ids `hostname-pollution`, `hostname-count` and `map-home-undetected` are now `server-name-pollution`, `server-count` and `server-location-undetected`.
- **Breaking:** database columns named `hostname` are now `server`, the `site_homes` table is `server_locations`, and the `hostname_daily_stats` aggregate is `server_daily_stats`. Queries that read the database directly need the new names. The log event `hostname_cagg_columns_unavailable` is now `server_cagg_columns_unavailable`.
- Upgrade the full instance and every agent together. The first start renames the database columns and tables in place, without rewriting any data. An agent from an older release still starts against the renamed database, then fails every insert.

### Fixed

- `DB_DROP_ON_STARTUP=true` drops the tables again in a development environment. On TimescaleDB 2.x the drop failed and nothing was dropped.
- The container no longer reports unhealthy while it is still starting. Docker ignores failed health checks for the first 60 seconds and checks every 2 seconds in that window, so the container turns healthy as soon as it answers. Before, a start that took more than about 10 seconds marked it unhealthy.
- Tooltips are easier to read in light and dark mode. They use the same background as menus, so the grey descriptions and the changelog notice in the sidebar tooltips have enough contrast.
- `import-logs` no longer drops the access-log rows of a whole file when only its first line is in a looser format, such as nginx's `common` ahead of the full format. It now detects the format from the first 1,000 lines.
- After `import-logs` and the backfill commands, analytics include the first and last day of the range they wrote. Before, those partial days stayed missing from the daily views. An import that didn't cover a whole UTC day failed the daily refresh outright, and `import-logs` still printed "CAGGs refreshed." It now exits with an error when a refresh fails.
- The log file list in Settings no longer fails with a server error when GeoMetrikks lacks permission to a configured access log's directory. The file shows as not readable.
- An access log that exists but sits in a directory GeoMetrikks cannot open is no longer reported as "does not exist" at startup. The log names the permission error, and `/health` gives the reason as `unreadable` instead of `missing`. The same applies when the file itself cannot be read. The Ingestion card on the Status page says "not readable" for such a file instead of "missing".

### Removed

- The sidebar no longer has the "Live feed" indicator. It read "Live feed off" on every page except the map and the access-logs live tail, which looked like a fault. Those two pages and the Status page still show whether the live feed is connected.

## [0.20.0] - 2026-10-05

### Added

- The Banned IPs map popup can open a decision's alert. Click the scenario name to see the same alert details as on the Security page.
- `MAP_DEFAULT_VIEW` sets where the map opens, as `latitude,longitude` or `latitude,longitude,zoom`. The zoom defaults to 3. For example, `MAP_DEFAULT_VIEW=71.129982,27.653369,15` opens on northern Norway at zoom 15. `GET /api/v1/settings` returns it as `map.defaultView`.
- Setup guide for Nginx Proxy Manager in the README.
- `/health` lists each log source ingestion is waiting for under `ingestion.unavailableSources`, with its kind and the reason. `missingFiles` is unchanged.

### Changed

- The map opens on the site homes instead of on Europe. It centers on a single home at zoom 3, and fits several homes into view, clear of the map controls. When the URL filters to one source, the map opens on that source's home. With no homes, it opens on the whole world. `MAP_DEFAULT_VIEW` overrides all of these.
- Removed the recursive `chown` over `/app` in the Dockerfile. Freed up around 280 MB from the image and builds faster.
- The image build runs `vite build` without the TypeScript typecheck that `bun run build` adds. CI still typechecks the frontend.

### Fixed

- Requests logged while GeoMetrikks was still checking the log format at startup are no longer skipped. On a fresh install this was the first request written to an empty log file.
- The map and the Geo Logs spatial preview say so when the browser cannot start WebGL2, which the map needs. They used to stay blank and log the error only to the browser console. The message includes the browser's own reason when it gives one. The rest of the page keeps working.
- A pinned log format (`LOGPARSER_LOG_FORMATS`) no longer turns off access-log storage when the log file is still empty 60 seconds after startup. This hit fresh installs before the proxy wrote its first line, and lasted until a restart.
- Log lines written while a GeoLite2 database refresh is applied are no longer lost.
- A log rotation that happened while unread lines were still waiting in the old file is now detected. Before, GeoMetrikks could keep watching the renamed file and ingest nothing from that log until the next rotation.
- Stopping GeoMetrikks no longer waits out `LOGPARSER_POLL_INTERVAL` while a log file is idle or missing. With an interval of 10 seconds or more, shutdown stalled for 10 seconds and logged that a tail task did not stop gracefully.

## [0.19.0] - 2026-09-27

### Added

- Each time-series chart in Analytics and Geo Logs has a menu for view and scale. Scale can be log (the default), linear with spike clipping, or linear full range. Requests, Bandwidth and Geo events can show bars. Status classes can show each class's share of responses, or the error rate. Request latency now opens as a p50 to p95 band, and its old lines view is still in the menu. Each chart keeps its choice after a reload.
- CrowdSec 1.8 bot detection on the Security page. Alert history has a kind selector for all kinds, detections, WAF and bot detection, and labels WAF and bot-detection alerts. Opening a rejected browser challenge shows a Challenge section with the outcome, the score, each signal that added to it and what the signal means, the fingerprint id with a copy button, the operating system, the user agent and the target path. Challenge events show the method, the path and the outcome on the row. `GET /api/v1/crowdsec/alerts` accepts `kind` and `hasActiveDecision` and returns `kind` on every alert. Filtering by kind needs CrowdSec 1.7 or newer. An older LAPI answers 400 with a message saying so.
- Country flags wherever the app shows a country, including the Country filter lists. Hover a flag for the country name. The map's Top IPs list shows the flag in place of the city, so the full IP fits, and hovering it shows the city. CrowdSec decisions with Country scope fill the Country column.
- Ban a CIDR range, or require a captcha instead of a ban. The Ban IP dialog takes an IP or a range and shows how many addresses a range covers. It has a Ban or Captcha choice, a custom duration such as `90m`, `3d` or `1d12h`, and a reason. "More options…" in the shield menu next to every IP opens the same dialog with that IP filled in. Active decisions can unban a range. `POST /api/v1/crowdsec/ban` accepts a CIDR in `ip`, a `type` of `ban` or `captcha`, and durations in days. `POST /api/v1/crowdsec/unban` accepts a CIDR.
- Links out to CrowdSec and bgp.he.net. The alert sheet links the source IP to CrowdSec CTI, the scenario to its CrowdSec Hub page and the AS to bgp.he.net. The IP inspector links its AS to bgp.he.net and, with CrowdSec configured, the IP to CrowdSec CTI. The Banned IPs map popup links each IP to CrowdSec CTI.
- Abuse reports for a hosting provider's abuse desk. The Abuse report button in the IP inspector, and the mail icon on each Top ASNs row in Analytics and Geo Logs, build a report on one IP or on the busiest IPs of an ASN over the selected range. It comes as plain text for an email or abuse form, or as a CSV of log lines. Each address gets its request count and response mix, notes on its 4xx share, path count and bursts, its CrowdSec detections and active decisions, its top paths and user agents, and a log excerpt, all in UTC. The report leaves out your vhosts, GeoMetrikks instance names, referrers, CrowdSec machine names and manual ban reasons. It also scrubs your hostnames and server address from paths and user agents, and drops any query value that points at one of your apps or holds an API key, token or password. The scrubbing can miss things, so read a report before you send it. Find abuse contact looks up the network's abuse address over RDAP. Only the IP or AS number goes out, to IANA and the regional registry. `GET /api/v1/reports/abuse` and `GET /api/v1/reports/abuse-contact` return the same data.

### Changed

- Clicking an IP in the map's Top IPs list opens its popup on the markers and Banned IPs layers. The map flies to the zoom where that location's marker leaves its cluster, and never zooms out. On a phone the controls drawer closes. If the current filters hide the location, the map flies there without a popup. Show on map in the IP inspector lands the same way.
- The CrowdSec alert endpoints return `countryCode` and `countryName` in place of `country`, which held a code or a name depending on the source. `countryName` is null when the LAPI supplied the country.
- Charts on a 7-day range, including the 7d preset and Last week, use daily buckets instead of hourly when granularity is Auto.
- The IP inspector's footer buttons stay at the bottom of the sheet while the rest scrolls. On a phone they show only the page's icon from the side menu.

### Fixed

- Chart tooltips show values of 0.
- The IP inspector took the newest alert for an IP as the ban start. A rejected browser challenge after the ban carries no decision, yet it moved the ban start and the "still seen after ban" signal with it. The lookup now asks for alerts with a live decision.
- The alert sheet said "1 events".
- Unbanning an IP also deleted every range decision that covered it, because the LAPI's delete matches any decision containing the IP. Unban now removes only the IP's own decisions.

## [0.18.0] - 2026-09-22

### Added

- Fly to an IP on the map. Every IP with an inspect button also gets a crosshair button that opens the map on the location where the IP was seen. Rows that already know the location land on it. Other rows resolve the IP to the location with the most events in the selected time range. An IP with no geo events in that range shows a toast. The map reads the IP from `?focusIp=<ip>`.
- Alert details on the Security page. Select a row in Alert history to open the alert. The sheet shows the context CrowdSec collected: targeted paths, user agents, methods, status codes and CVE. It lists the decisions the alert produced and marks the expired ones, then the stored events, the source AS number and the range. A link opens the IP in Access logs. `GET /api/v1/crowdsec/alerts/{id}` returns the same data.

### Changed

- Active decisions lists one row per IP. An IP that tripped several scenarios shows the scenario count and the longest time left. The row expands to every decision with its own scenario, origin and timer. Select a decision to open the alert that produced it. The page count follows IPs. `GET /api/v1/crowdsec/decisions` returns one item per target with a `decisions` array, `decisionCount` and `origins`, and `total` counts targets. `GET /api/v1/crowdsec/decisions/{id}/alert` returns the alert behind a decision.
- Alert history leaves out blocklist pulls. It showed each pull as an `update : +N/-M IPs` alert that carried every decision in the blocklist.
- Alert history greys out the decision count once every decision from that alert has expired. `GET /api/v1/crowdsec/alerts` reports the live count as `activeDecisionCount`.

## [0.17.0] - 2026-09-20

### Added

- Sign in through an OpenID Connect identity provider (Authelia, Authentik, Keycloak, Pocket ID, Google) with the authorization code flow and PKCE. Configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` and an allow list (`OIDC_ALLOWED_USERS` by verified email or subject, `OIDC_ALLOWED_GROUPS`). The login page shows a provider button, the password form, or both. `OIDC_LOGOUT_IDP=true` also ends the provider session on logout and lands on a signed-out page. Settings > Status shows whether the provider's discovery document could be fetched. `GET /api/v1/auth/options` reports the available login methods and `GET /api/v1/auth/oidc/status` the discovery outcome.

### Changed

- Sessions end 7 days after login instead of 7 days after the last request, and every login issues a fresh session id.
- `APP_ADMIN_PASSWORD` is optional when OpenID Connect is configured; without it the password form is hidden and `POST /api/v1/auth/login` answers 401.
- `POST /api/v1/auth/logout` answers 200 with `{"redirectTo": null}` (or the identity provider's end session URL) instead of 204. `/auth/me` reports the login `provider`.
- Anonymous API requests no longer receive a session cookie.

## [0.16.0] - 2026-09-13

### Added

- Banned IPs map view, a third visualization beside Heatmap and Markers. Red markers count the distinct IPs under a CrowdSec decision at each location. The popup lists those IPs with their current decisions and opens the IP inspector for any of them. The map controls show banned traffic totals and the top five banned IPs by requests. The view follows the time range and map filters and refreshes when decisions change. It replaces the Banned IPs overlay switch.
- Optional frame rate counter in the Map tools menu for manual performance testing. It counts map renders and does not force idle maps to repaint.
- Badges say which CrowdSec decision an IP holds. A ban stays the red Banned badge, a captcha decision shows an amber Captcha badge, and a bouncer-defined remediation shows its own name in grey, in the log tables, detail sheets, alerts, map popups and the IP inspector. The Security page's decisions table gains a Type column. Live traffic draws an amber cage ring over captcha'd packets and the live rail counts banned and captcha IPs separately.

### Changed

- `/api/v1/crowdsec/banned-ips` returns `{ip, type}` objects instead of bare addresses, and `/ws/crowdsec` decision frames carry the decision `type`.
- `/api/v1/crowdsec/banned-locations` returns a GeoJSON FeatureCollection instead of an array, carries an event count per IP, and treats `toTimestamp` as exclusive.
- Map popups open on whichever side keeps them inside the map. A marker near the top edge no longer hides its popup under the header.
- Live route effects update at most 30 times per second regardless of display refresh rate, and compute queued routes only when a packet can start.
- Go to home location and, on mobile, Fit to data bounds moved into a new Map tools menu. The mobile drawer lists Filters last.

## [0.15.0] - 2026-09-09

### Added

- Geo Logs now records the autonomous system number and organization for every geo event using the GeoLite2 ASN database, including on geo-only installs (`LOGPARSER_SEND_LOGS=false`). Top IPs shows each IP's organization. Top locations has an ASNs tab with hosting classification and exact unique-IP counts. The grouped table adds optional ASN and Organization columns, the detail panel shows the ASN, and ASN include and exclude filters apply to both the table and embedded map. The API adds `GET /api/v1/geo-events/top-asns` and the `asnIn` and `asnNotIn` parameters to the geo-events and geojson endpoints.
- `litestar backfill-asn --table geo-events` fills missing ASN data in historical geo events and refreshes the per-IP aggregates without touching Access Logs. The command now requires `--table access-logs`, `--table geo-events`, or `--table all` so it cannot decompress the wrong table by accident. On first start, Geometrikks adds the new aggregate columns and refreshes the raw-retention window. This can make startup slow on large installs. Buckets older than raw retention remain without ASN data.

### Fixed

- Geo Logs now shows recording hostnames for ranges over 24 hours. Existing installations can fill retained history with `litestar backfill-geo-hostnames`; it refreshes one day at a time and resumes after interruption.

## [0.14.3] - 2026-09-07

### Added

- Startup waits for the database for up to `DB_STARTUP_WAIT_SECONDS`, which defaults to 30 seconds. If it remains unreachable, the app serves in degraded mode with a critical Status advisory and keeps checking. When the database returns, recovery runs the deferred migrations and starts the paused services.
- Status page advisories for a disconnected live-feed listener, a missing or stale GeoLite2 database, an undetected map home, failed TimescaleDB policy updates, dropped ingestion batches, stopped ingestion, and a failing CDN peer scan. The sidebar dot turns amber while any advisory is open.

### Changed

- Health reports degraded whenever database-bound services are paused, even with ingestion disabled by configuration, and the database card says "Reachable, services paused" for that state.
- The Scheduler page identifies database unavailability as the reason jobs have not started.
- Live feed indicators say "paused" when the server refuses the stream, and the CrowdSec card notes when live updates are paused.
- `.env.example` and the quickstart now list `MAP_CARTO_API_KEY` next to the MaxMind credentials.

### Fixed

- Failures from the GeoIP refresh, location refresh and aggregate refresh jobs appear on the Scheduler page.
- A configured log file that has not appeared is listed as missing, and tailing starts when the file appears.
- The site-home refresh job updates the map home without a restart.
- A failed CDN peer scan retains the previous findings and keeps the advisory open.
- The live rail on the map stops short of the bottom-left corner, so it no longer covers the basemap attribution pill.
- Access, geo, and debug log tables render only visible rows, reducing the delay when opening record details or the IP Inspector on large pages.

## [0.14.2] - 2026-09-05

### Added

- `MAP_CARTO_API_KEY` sends a CARTO basemaps API key with every basemap request, as CARTO's terms now require. Keys are free; see the README.

### Fixed

- The map and the geo-logs map now show the CARTO and OpenStreetMap attribution that both licenses require. It was hidden before. The pill collapses to an info button on click or drag, and that state is remembered in the browser.

## [0.14.1] - 2026-09-02

### Changed

- Access-log parsing and the Method filter now recognize every method in the IANA HTTP Method Registry, including WebDAV versioning and binding methods, `QUERY`, and the reserved `*` method. The legacy nginx parser also accepts registered hyphenated methods instead of dropping their method field.
- HTTP method columns expand from 10 to 32 characters. On the first startup after upgrading, the migration decompresses existing `access_logs` and `access_log_debug` chunks before changing their column types; this may temporarily require additional disk space, and the normal compression policy recompresses eligible chunks afterward.

### Fixed

- Legacy nginx logs with empty quoted fields, including an explicitly empty Referer header, now parse without dropping the line or shifting later fields.

## [0.14.0] - 2026-09-01

### Added

- Caddy is a supported log source: the `caddy-json` format parses Caddy's native JSON access logs, auto-detected like the other formats and available to `import-logs --format caddy-json`. Add `log_append upstream_duration_ms {rp.upstream.duration_ms}` to record optional upstream timing. Behind a CDN or another proxy, set `servers.trusted_proxies` so Caddy logs the visitor's address; the README's Caddy setup section has the details.
- Settings > Status warns when most recent traffic for a tailed log comes from CDN addresses (the map would show the CDN's datacenters) or from private addresses (nothing reaches the map at all), naming the affected sources and the proxy directive to fix, with a link to the new docs/proxy-setup.md. Detection is a rolling in-process window with no database cost; `APP_PROXY_ADVISORY=false` turns it off. Every 5 minutes the head scans agent-tailed sources' access-log rows in the shared database to produce their CDN findings; private-peer findings for agent sources still report on the agent's own `/health`.

### Fixed

- Add missing status codes (444, 499) in access logs status code filter dropdown.

## [0.13.0] - 2026-08-31

### Added

- Settings > Changelog lists every release from `CHANGELOG.md`, newest first, each linked to its GitHub compare view, with the one this install is running expanded and marked. A build ahead of the last release (a develop image, a local build, a source checkout) marks the Unreleased section instead. After an upgrade, the Settings entry in the sidebar and the Changelog tab show a dot until the page is opened once in that browser. Backed by `GET /api/v1/system/changelog` and a `changelogDigest` field on `/api/v1/system/about`; the container image now ships the changelog next to `alembic.ini`.
- Settings > About shows the commit the build came from, linked to GitHub, next to the version (release and CI images carry it; a local `docker build` does not), and the Database card shows the alembic revision the database is on and whether it matches the one this build ships.

### Fixed

- Startup refuses an `ANALYTICS_RAW_RETENTION_DAYS` below 4 with a message naming the aggregate and the floor. The daily aggregates refresh their last 3 days from raw rows, so a shorter raw retention made every refresh find empty raw data under part of that window and delete the materialized rows, with nothing in the logs.
- Changing any of the `ANALYTICS_*` policy settings (`RAW_RETENTION_DAYS`, `DEBUG_RETENTION_DAYS`, `HOURLY_RETENTION_DAYS`, `COMPRESSION_AFTER_DAYS`, `CAGG_REFRESH_INTERVAL_MINUTES`) on an existing database now updates the TimescaleDB policies on the next start (`policy_updated` in the logs). Until now the policies kept whatever values the database was first created with, and the new value was only logged at debug level and dropped.
- The `traefik-json` format takes the rightmost address of an `X-Forwarded-For` chain in `ClientHost`, not the leftmost. Traefik logs the chain as it arrived from a trusted peer without appending the peer, so the leftmost entry is whatever the client sent and any client could put an arbitrary address on the map; the rightmost entry is the one the trusted proxy added.

## [0.12.1] - 2026-08-30

### Changed

- The map runs on MapLibre GL JS 6 (6.6.0, up from 5.24.0).
- The backend's HTTP client is `httpx2` 2.12 instead of `httpx`; the unused `httpx-oauth` dependency is dropped. The container image builds on `oven/bun` 1.4.0.
- The API reference at `/schema` is rendered by Scalar. The ReDoc, Swagger UI, RapiDoc and Stoplight pages and `/schema/openapi.yaml` are gone; `/schema/openapi.json` is unchanged.

## [0.12.0] - 2026-08-29

### Added

- IP inspector. Every IP in the app (map popup and controls, top-IP lists, the log tables and their detail panels, the alerts and decisions tables) gets an inspect button that opens a side panel for that address. The panel covers the selected range: request and error counts, bytes, timing, first and last seen, busiest hour or day, the hosts and paths it hit, user agents, other locations it resolved to, its latest requests and its CrowdSec decision. Scanner tells show as chips with a hover explanation of what each one means: high 4xx share, hosting ASN, wide path spread, bursts, malformed lines, traffic still arriving after a ban. Clicking a bar in the panel's chart narrows the time range to that hour or day, with a way back to the range you came from; the panel has its own range picker. Footer links carry the IP to Analytics, Access logs and, when it produced malformed lines, Debug logs. The panel lives at `?inspect=<ip>`, so it survives navigation and can be linked. Backed by a new `GET /api/v1/analytics/ip-profile` endpoint.
- Response-time cards and the latency chart read "n/a" when the selected range has no measured requests, and "From N% of requests" when only some rows carry a timing. Top URLs and the access-log table show "n/a" for rows without one.
- `litestar backfill-timings` clears the placeholder 0.0 response time on rows imported from `combined`-format nginx archives. `--hostname` and `--before` narrow which rows it touches.

### Changed

- Side panels darken the page behind them instead of blurring it. The map's load-failure message sits on the brand map scene, the same one the map shows while loading.
- A missing `request_time` is now NULL instead of 0.0, so unmeasured requests stop dragging the response-time average and percentiles toward zero. The summary and URL aggregates gain a count of measured rows. The first start after upgrading adds that column in place and refreshes those four aggregates over the raw retention window; on a large database this takes minutes, and no history is lost. Buckets older than the window keep their pre-upgrade figures, which counted every row, because the raw rows needed to recount them are gone.
- nginx status 408, 444 and 499 no longer mark a request as malformed. A 444 is usually a block rule and a 499 is a client that hung up, so those lines now land in Access logs like any other request instead of filling the Debug page and the malformed count. Probe detection is unchanged; TLS, SSH and SMB handshakes and requests without a valid HTTP method are still flagged.
- Response-time figures (average, max, percentiles, and the Top URLs average) skip WebSocket connections (status 101) and connections that ended without a response (status 0). Their logged time covers the whole connection, not the response, and one open WebSocket was enough to put the Max Request Time card at 9000 s. The rows keep their duration in Access logs. The summary and URL aggregates gain filtered latency columns; the first start after upgrading adds them in place and refreshes those four aggregates over the raw retention window, the same way as the measured-row counts. The Top URLs column is labelled Path, which is what it shows.
- Top URLs lists one row per host and path. A path that several proxied hosts share, such as `/graphql` or `/favicon.ico`, used to show as one row with every host's hits summed; now each host gets its own row, with a Host column before Path. The first start after upgrading rebuilds the two URL aggregates over the raw retention window (minutes on a large database, `url_caggs_recreated` in the logs). Per-URL history older than that window cannot be rebuilt and is dropped; every other chart and card keeps its history.

### Fixed

- The Overview's Avg and Max Request Time cards formatted seconds as if they were milliseconds, showing a 40 ms average as 40μs.
- Stat cards on the Summary, Geo logs and Debug logs pages no longer read "Last Last month" or "Last Today" for calendar presets. Calendar ranges show their own name, and trends on the Summary page read "vs previous period" instead of "vs last Yesterday".
- The map basemap follows the System theme. It stayed dark while the rest of the app switched to light with the OS, and now switches with it, live.
- Stopping the app while it was tailing a log logged one `live event publish failed` traceback per row in the final batch. The live-events channel closed before ingestion flushed that batch; it now closes after. The rows were always committed, only their live-map events went missing.

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

[Unreleased]: https://github.com/GilbN/geometrikks/compare/v0.22.1...develop
[0.22.1]: https://github.com/GilbN/geometrikks/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/GilbN/geometrikks/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/GilbN/geometrikks/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/GilbN/geometrikks/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/GilbN/geometrikks/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/GilbN/geometrikks/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/GilbN/geometrikks/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/GilbN/geometrikks/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/GilbN/geometrikks/compare/v0.14.3...v0.15.0
[0.14.3]: https://github.com/GilbN/geometrikks/compare/v0.14.2...v0.14.3
[0.14.2]: https://github.com/GilbN/geometrikks/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/GilbN/geometrikks/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/GilbN/geometrikks/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/GilbN/geometrikks/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/GilbN/geometrikks/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/GilbN/geometrikks/compare/v0.11.0...v0.12.0
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
