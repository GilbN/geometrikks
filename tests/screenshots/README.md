# Docs screenshots

`uv run python -m tests.screenshots` brings up a throwaway GeoMetrikks instance with seeded traffic, screenshots every scene in `plan.py` in both themes, encodes the shots to WebP and publishes them to `data/screenshots/`. Then it removes everything it started. Run it by hand on a dev machine. It refuses to start when `CI` is set.

Scene ids in `plan.py` are public. The docs place shots with `<Screenshot scene="map" />`, and `ShotPair` throws on an id the manifest lacks. Removing or renaming a scene therefore breaks the build of every version folder under `site/content/docs` that uses it, so keep the id while any folder does.

## Before a run

- Docker running, and the shared TimescaleDB server at `postgresql://geouser:geopass@localhost:5432/postgres` (the dev `timescale_db` container), unless you pass `--own-db`. The preflight refuses when that server does not answer.
- GeoLite2 City and ASN databases. The defaults are `~/dev/geometrikks/data/geoip/GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb`.
- A CARTO basemap key. CARTO's terms want one key per deployment, so export your own as `MAP_CARTO_API_KEY` or pass `--carto-key`.
- `bun install` at the repo root and in `site/`. The encoder needs `site/node_modules/sharp`.
- No Vite dev server for this checkout. The run refuses while `public/hot` exists, because the app would load its assets from the dev server.
- At least 3 GiB of available memory and 10 GB of free disk. The preflight names both numbers when either is short.

## Command and flags

```bash
uv run python -m tests.screenshots [--dry-run] [--cleanup] [--only scene,scene] [--hold] [--own-db] [--no-build]
                                   [--pg-admin-url URL] [--city-db PATH] [--asn-db PATH] [--carto-key KEY]
```

| Flag | What it does |
| --- | --- |
| `--dry-run` | Runs the preflight and prints its problems, the app's environment with secrets as `***`, the shots in capture order, the teardown plan and Playwright's test list. It starts no container, database or server and never touches `data/screenshots/`. Exits 2 when the preflight found problems, else 1 when Playwright cannot list the tests, else 0. A scene with no stage fails the list with `unknown scene: <id>`. |
| `--cleanup` | Removes what a crashed or killed run left behind. See below. |
| `--only map,live` | Retakes these scenes. Their files and manifest entries are replaced, and every other scene's files and entries stay as they are. A retake needs a readable `data/screenshots/manifest.json`. Without one the run exits 2 before it starts anything, and you need a full run first. The captcha and range picks and each ban's scenario can change between runs, so retake `security`, `drop-networks`, `banned-map`, `ip-inspector`, `abuse-report` and `abuseipdb-report` together, or their decisions won't match. |
| `--hold` | Waits after capture, whether it passed or failed, and prints the PNG folder, the instance's URLs and the login. Enter goes on to encode and publish. Ctrl-C tears down without publishing. |
| `--own-db` | Starts a private `timescale/timescaledb-ha:pg18-ts2.30` container with `--memory 1g` instead of a database on the shared server. Use it when the shared server is down or already holds `geometrikks_screenshots`. |
| `--no-build` | Uses the bundle already in `public/`. Without it the run builds the bundle with `vite build` through `tests/screenshots/vite.config.ts`, then fails if the build rewrote `resources/generated`. It refuses a bundle that `bun run build` made, because only the screenshot bundle counts documentation addresses as public. That bundle stays in `public/` after the run, so rebuild before you serve `public/` yourself. |
| `--pg-admin-url` | Admin URL of the TimescaleDB server. Defaults to `SHOTS_PG_ADMIN_URL`, then the dev server above. |
| `--city-db`, `--asn-db` | The GeoLite2 files the seed and the live feeder place visitors with. |
| `--carto-key` | Defaults to `MAP_CARTO_API_KEY` as exported in your shell. |

The script never reads `.env`. Before it imports any app code it removes every app setting from its own environment (`APP_`, `DB_`, `CROWDSEC_` and the other prefixes in `environment.py`, in any letter case, plus the proxy variables), and turns dotenv loading off. Each process it starts gets an environment built from scratch. The instance logs in as `admin` / `admin`.

The frontend build and the encoder don't read your dotenv files either. Both run under Bun with `--no-env-file`, so Bun never loads `.env` into their environment. The build goes through `tests/screenshots/vite.config.ts`, which wraps the repo's `vite.config.ts` and points Vite's `envDir` at an empty folder in the run folder. Vite would otherwise bake `VITE_*` keys from `.env`, `.env.production` and `.env.local` into the bundle. The wrapper refuses to load outside a run. One local file still counts. The litestar-vite plugin reads `.litestar.json`, the bridge file your dev server writes, for paths such as the asset URL.

## What a run starts

In order:

1. The scratch database `geometrikks_screenshots`, migrated and set up for TimescaleDB. That name is reserved for this script: a run creates and drops it, and `--cleanup` drops it whenever it exists.
2. The seed: 150,000 requests over 30 days with seed 42 for the servers `edge` and `homelab`, plus seven documentation-range scanners, twelve documentation-range home browsers (see below), the DROP fixture lists and four AbuseIPDB reports.
3. `geometrikks-shots-crowdsec`, a CrowdSec LAPI with 512 MB of memory, on the internal network `geometrikks-shots-net`. Both carry the label `geometrikks.screenshots.run=<run id>`. The run loads it with alerts and decisions for the fixture IPs.
4. The app under uvicorn on a free port, bound to `0.0.0.0`, tailing two empty log files in the run folder.
5. Playwright with one worker, in two passes. The live scenes come last, while the live feeder appends requests from the seeded visitors to those log files.

Then the run encodes the PNGs, writes `manifest.json` and swaps the new folder in for `data/screenshots/` in two renames. A failed or interrupted run publishes nothing, with one exception. The run ignores Ctrl-C and SIGTERM during the two renames, so an interrupt that lands there does not stop the swap. That run still publishes and exits 0. PNGs and files whose names the run does not recognize always stay in `data/screenshots/`.

Nothing in the run contacts the owner's CrowdSec LAPI, Spamhaus, AbuseIPDB, RDAP, GitHub releases or a public-IP service. The CrowdSec container sits on a network with no route out. The DROP lists come from fixture bodies through a mock transport, and the run fails before publishing if their copyright marker changed or any DROP entry falls outside documentation space. It also stops before capture if the LAPI holds a decision for an IP the fixtures did not create. AbuseIPDB has its own section below. Playwright loads basemap tiles from CARTO with your key.

A full run takes about 15 to 20 minutes, most of it seeding and capture. At its peak it holds the CrowdSec container, the app, Playwright with one browser and, with `--own-db`, a 1 GB database container.

## Lock, ledger and run folder

Everything lives in `/tmp/geometrikks-screenshots-<uid>/`:

- `run.lock`: one run at a time. A second run, a dry run or a cleanup started while one holds it exits 2 and names the lock file.
- `ledger.json`: every process group, container, network, database and folder a run creates, written before the call that creates it. Teardown acts only on entries it can prove it owns.
- `run-<run id>/`: logs, the plan, the live log files, PNGs and WebPs. Teardown removes it, so read the logs while the run holds (`--hold`) or from the lines a failed run prints.

On exit, interrupt (Ctrl-C, SIGTERM) or failure, the run stops its processes, removes its containers, network, database and run folder, and prints one line per problem. Exit codes: 0 done, 1 failed, 2 preflight or lock, 130 interrupted. A run that published its shots still exits 1 when teardown left one of its resources in the ledger or could not stop a stray capture process.

## After a crash or `kill -9`

A run that cannot tear down, such as one killed with SIGKILL, leaves its ledger behind, and the next run or dry run reports it. Run:

```bash
uv run python -m tests.screenshots --cleanup
```

It loads every ledger entry, adds every container and network labelled `geometrikks.screenshots.run` and the reserved database, and removes them. After an `--own-db` run, pass `--own-db` here too. That run's database lived in the `geometrikks-shots-db` container, which goes with the other labelled containers, so cleanup then skips the shared server and doesn't fail when it is down. It also stops stray processes from an earlier capture and removes leftover dry-run folders. Before it removes anything, it writes the labelled resources and the database it found into the ledger, so whatever it cannot remove stays listed for the next try. It exits 0 and prints `cleanup: nothing left` only when everything is gone. It exits 1 when it could not list the labelled resources, could not reach the database server, could not remove something, could not stop a stray capture process, or could not repair an interrupted publish. A dry-run folder whose processes it could not stop stays, and the output names it. If the ledger is unreadable, it says so, leaves the file for you to read and delete, still removes the labelled resources and the database, and exits 1.

Run it soon after the crash. systemd-tmpfiles deletes files in `/tmp` that are older than 10 days on ripley, and once the ledger is gone `--cleanup` can no longer find the processes a killed run left.

## CrowdSec fixture facts

The run starts a throwaway CrowdSec LAPI and fills it with alerts for the fixture IPs. A spike against the real image on 2026-11-11 found these facts. `lapi.py` encodes them as constants and payload rules.

- The image is `crowdsecurity/crowdsec:v1.8.1` (`CROWDSEC_IMAGE`).
- The entrypoint exits with code 0 unless `/var/lib/crowdsec/data` is a mount. The container gets an anonymous volume there (`-v /var/lib/crowdsec/data`). `docker rm -f -v` removes the volume along with the container.
- The env holds `DISABLE_ONLINE_API=true`, `DISABLE_AGENT=true`, `NO_HUB_UPGRADE=true` and `BOUNCER_KEY_geometrikks=<key>`. With these set, the container makes no hub download and never registers with the Central API.
- The container runs on `geometrikks-shots-net`, created with `docker network create --internal`. DNS fails inside it, so nothing leaves. No port is published. The host and the app reach the LAPI at the container's own address on that network, `http://<container ip>:8080`.
- The LAPI answers `GET /health` with `{"status":"up"}` about a second after `docker run`. Before that the connection is refused.
- An empty decision list comes back as the JSON literal `null`, not `[]`.
- `cscli machines add <id> --password <pw> -f /dev/null` creates a machine that is already validated. `POST /v1/watchers/login` returns a JWT that lasts one hour.
- The LAPI overwrites `created_at` with the insert time. It keeps `start_at`, `stop_at`, the event timestamps, the `source` geo and ASN fields and the context `meta`. An alert cannot be backdated through `created_at`.
- A decision expires at `stop_at` plus its duration, not at insert time plus duration. A ban that must still be active at capture gets the time the payload is built as its `stop_at`. Its `start_at` can still be days back, at the oldest event.
- A `1s` decision is gone before the first `GET`. The expired bans use `1s` with `stop_at` at their newest event, so they are already expired when the LAPI stores them.
- `remediation: false` reads back as absent.

The alert history list shows `created_at`, so every fixture alert there shows the time the run posted it. The alert detail sheet shows `start_at` and `stop_at` as "First event" and "Last event". The abuse report sorts and dates alerts by `start_at`.

## Documentation visitors

Seed scanners are random addresses inside real hosting ASNs. If one were DROP-listed, a real provider's name would sit next to Spamhaus's description of networks "hijacked or run by spam and cybercrime operations". So no seed IP and no seed ASN goes on a DROP list.

The fixture step writes seven extra scanners instead:

| Address | DROP v4/v6 | Banned |
| --- | --- | --- |
| 203.0.113.10 | 203.0.113.0/24 | |
| 203.0.113.23 | 203.0.113.0/24 | |
| 203.0.113.77 | 203.0.113.0/24 | |
| 198.51.100.14 | 198.51.100.14/32 | yes, and the IP the inspector and abuse report open |
| 198.51.100.200 | none | |
| 2001:db8:d0c::5 | 2001:db8:d0c::5/128 | yes |
| 2001:db8:d0c::9e | none | |

All seven come from the RFC 5737 and RFC 3849 documentation ranges and sit under AS64496 "Fictional Example Hosting", an RFC 5398 documentation ASN. 198.51.100.200 and 2001:db8:d0c::9e sit on no network list; only the ASN-DROP entry for AS64496 covers them. Their user agents leave out CensysInspect, l9scan and masscan, which name a real organization or person.

The DROP feeds also always carry a filler record, 192.0.2.64/26 and 2001:db8:ffff::/48. No visitor uses those, so they match no traffic, and 192.0.2.64/26 leaves out the capture browser's own address, 192.0.2.10. `feed_bodies` refuses any network outside the documentation ranges or over the home ranges below, and the copyright line of every fixture feed reads "GeoMetrikks screenshot fixture, not Spamhaus data". The run checks for that line before it publishes. If it is gone, the app downloaded the real lists.

These visitors have no location. GeoLite2 places none of these addresses, so ingestion would store their requests with no country or city and write no `geo_events` row. The fixture rows do the same. That affects three scenes:

- `drop-networks` lists 203.0.113.0/24 with 3 IPs, 198.51.100.14/32 and 2001:db8:d0c::5/128, each under AS64496. The card has no country column.
- `ip-inspector` opens 198.51.100.14. The header shows the ASN with no flag or city, the locations block is empty, and the map behind the sheet keeps its view, since the address has no marker. Its badges include the AbuseIPDB blacklist mark and score, which only the screenshot build allows for a documentation address (see AbuseIPDB below).
- `abuse-report` for 198.51.100.14 names the network as `AS64496 Fictional Example Hosting` with no country code. Its DROP notice covers both the v4 listing and the ASN-DROP listing.

### AbuseIPDB

The app starts with `ABUSEIPDB_API_KEY` empty and reporting and the blacklist off. With no key it builds no AbuseIPDB client, so the check, the report and the blacklist download have nothing to send with. The run asks `/api/v1/abuseipdb/status` after login and stops if the server says any of the three is on.

What the shots need from AbuseIPDB comes from elsewhere:

- The fixture step writes four reports straight into `abuseipdb_reports`, for the AS64496 visitors 203.0.113.23, 2001:db8:d0c::5, 198.51.100.14 and 203.0.113.10. They were sent by the user `admin` or the API key `homepage-widget`, and the one for 2001:db8:d0c::5 is Unconfirmed.
- The capture browser answers `status` (key set, reporting and blacklist on), `blacklist` (198.51.100.14 only) and `check` (198.51.100.14, 100%) from the plan, which `abuseipdb.py` builds with the app's own response types.
- The app refuses a documentation address on `GET /api/v1/abuseipdb/reports`, so the browser answers that one from `reports/history`, which reads the same table. If that read fails, the browser refuses the request.
- `reports/history` and `reported-ips` reach the app. Any other AbuseIPDB call, a `POST` above all, is refused, and the shot fails.

After capture and any `--hold`, the run stops the app with SIGINT. uvicorn re-raises the signal once it has shut down, and SIGINT then ends in a normal interpreter exit whose exit hook drains the app's log queue into `app.log`. SIGTERM would kill it before that. An app that doesn't exit within 30 seconds fails the run. Then, before anything is encoded or published, the run fails if `abuseipdb_reports` holds an address other than the AS64496 visitors, if either blacklist table holds a row, or if the app log has an AbuseIPDB event (`abuseipdb_check`, `abuseipdb_report_*`, `abuseipdb_blacklist_*`), `abuseipdb.com`, or a request to the app's `check` or `POST reports`.

The app hides the AbuseIPDB score and disables Report to AbuseIPDB… for an address that isn't public, and every fixture address is documentation space. So `tests/screenshots/vite.config.ts` patches `isPublicIp` in `resources/lib/abuseipdb.ts` to also take 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 and 2001:db8::/32, in the screenshot bundle only. If the app changes the start of `isPublicIp`, or the build never loads that file, the build fails. `abuseipdb-report` opens the form from Report to AbuseIPDB… in the actions menu of the 198.51.100.14 row on the Reports tab, checks that Send report is enabled and that "not a public address" appears nowhere, then presses Check to show the score. It never presses Send.

### Home visitors

The Overview puts the Spamhaus DROP card next to the Top network card. On the seed alone the top network is a real one (AS749, the US Department of Defense, about 4,100 requests in 7 days). So the fixture step also writes twelve home browsers under AS64497 "Example Broadband", the second RFC 5398 documentation ASN. They use 192.0.2.128/25 and 2001:db8:b0b::/48, which no DROP list touches and which leave out 192.0.2.10.

`write_doc_traffic` counts the busiest network of the last 7 days after the scanners are written. The home browsers then send 1.5 times that, and never fewer than 6,000 requests. They are spread over the 7 days by local time of day and end two hours before the run started. After the aggregate refresh the step checks that AS64497 leads the runner-up by 1.5 times and stops the run if it does not. The run log prints the top three networks.

What the home browsers look like:

- Browser user agents from the seed's list, none with a URL in it.
- Seed browser paths and statuses, so mostly 200s. They never request a path in `PROBE_PATHS`, and they write no probe lines.
- No country, city or `geo_events` row, like the AS64496 scanners. They never appear on the map.
- AS64497 is on neither the hosting list nor ASN-DROP, so their requests count as "other" on the Hosting traffic card.

`pick_fixture_ips` never takes them for a ban, the inspector or the map focus. It refuses them if they have no recent traffic, a location, another ASN or a probe hit. The live feeder replays only seed visitors, and the run's live-IP check treats any documentation address as unknown history, so a home browser in the live window fails the run.

The seed scanners keep every other CrowdSec fixture: active and expired bans, detections, the captcha and the range ban. Their alerts name probing scenarios only (`crowdsecurity/http-probing`, `http-sensitive-files`, `http-wordpress-scan`, `http-admin-interface-probing`). The captcha and the range ban go through the app's own ban call with the reason "Repeated probing".

The live feeder never emits these visitors. Ingestion skips `2001:db8::/32`, so only the written history holds them.
