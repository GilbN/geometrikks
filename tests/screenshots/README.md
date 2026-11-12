# Docs screenshots

`uv run python -m tests.screenshots` brings up a throwaway GeoMetrikks instance with seeded traffic, screenshots every scene in `plan.py` in both themes, encodes the shots to WebP and publishes them to `data/screenshots/`. Then it removes everything it started. Run it by hand on a dev machine. It refuses to start when `CI` is set.

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
| `--only map,live` | Retakes these scenes. Their files and manifest entries are replaced, and every other scene's files and entries stay as they are. A retake needs a readable `data/screenshots/manifest.json`. Without one the run exits 2 before it starts anything, and you need a full run first. The captcha and range picks and each ban's scenario can change between runs, so retake `security`, `drop-networks`, `banned-map`, `ip-inspector` and `abuse-report` together, or their decisions won't match. |
| `--hold` | Waits after capture, whether it passed or failed, and prints the PNG folder, the instance's URLs and the login. Enter goes on to encode and publish. Ctrl-C tears down without publishing. |
| `--own-db` | Starts a private `timescale/timescaledb-ha:pg18-ts2.30` container with `--memory 1g` instead of a database on the shared server. Use it when the shared server is down or already holds `geometrikks_screenshots`. |
| `--no-build` | Uses the bundle already in `public/`. Without it the run calls `bun run build` with the typegen environment, then fails if the build rewrote `resources/generated`. |
| `--pg-admin-url` | Admin URL of the TimescaleDB server. Defaults to `SHOTS_PG_ADMIN_URL`, then the dev server above. |
| `--city-db`, `--asn-db` | The GeoLite2 files the seed and the live feeder place visitors with. |
| `--carto-key` | Defaults to `MAP_CARTO_API_KEY` as exported in your shell. |

The script never reads `.env`. Before it imports any app code it removes every app setting from its own environment (`APP_`, `DB_`, `CROWDSEC_` and the other prefixes in `environment.py`, in any letter case, plus the proxy variables), and turns dotenv loading off. Each process it starts gets an environment built from scratch. The instance logs in as `admin` / `admin`.

The frontend build is the one place your dotenv files still count. `vite build` loads `VITE_*` keys from `.env`, `.env.production` and `.env.local` into the bundle the app serves, so a `VITE_` setting there ends up in the screenshots. Move those keys out of the way before a run if they would change what the pages show.

## What a run starts

In order:

1. The scratch database `geometrikks_screenshots`, migrated and set up for TimescaleDB. That name is reserved for this script: a run creates and drops it, and `--cleanup` drops it whenever it exists.
2. The seed: 150,000 requests over 30 days with seed 42 for the servers `edge` and `homelab`, plus seven documentation-range scanners, twelve documentation-range home browsers (see below) and the DROP fixture lists.
3. `geometrikks-shots-crowdsec`, a CrowdSec LAPI with 512 MB of memory, on the internal network `geometrikks-shots-net`. Both carry the label `geometrikks.screenshots.run=<run id>`. The run loads it with alerts and decisions for the fixture IPs.
4. The app under uvicorn on a free port, bound to `0.0.0.0`, tailing two empty log files in the run folder.
5. Playwright with one worker, in two passes. The live scenes come last, while the live feeder appends requests from the seeded visitors to those log files.

Then the run encodes the PNGs, writes `manifest.json` and swaps the new folder in for `data/screenshots/` in two renames. A failed or interrupted run publishes nothing, with one exception. The run ignores Ctrl-C and SIGTERM during the two renames, so an interrupt that lands there does not stop the swap. That run still publishes and exits 0. PNGs and files whose names the run does not recognize always stay in `data/screenshots/`.

Nothing in the run contacts the owner's CrowdSec LAPI, Spamhaus, RDAP, GitHub releases or a public-IP service. The CrowdSec container sits on a network with no route out. The DROP lists come from fixture bodies through a mock transport, and the run fails before publishing if their copyright marker changed or any DROP entry falls outside documentation space. It also stops before capture if the LAPI holds a decision for an IP the fixtures did not create. Playwright loads basemap tiles from CARTO with your key.

A full run takes about 15 to 20 minutes, most of it seeding and capture. At its peak it holds the CrowdSec container, the app, Playwright with one browser and, with `--own-db`, a 1 GB database container.

## Lock, ledger and run folder

Everything lives in `/tmp/geometrikks-screenshots-<uid>/`:

- `run.lock`: one run at a time. A second run, a dry run or a cleanup started while one holds it exits 2 and names the lock file.
- `ledger.json`: every process group, container, network, database and folder a run creates, written before the call that creates it. Teardown acts only on entries it can prove it owns.
- `run-<run id>/`: logs, the plan, the live log files, PNGs and WebPs. Teardown removes it, so read the logs while the run holds (`--hold`) or from the lines a failed run prints.

On exit, interrupt (Ctrl-C, SIGTERM) or failure, the run stops its processes, removes its containers, network, database and run folder, and prints one line per problem. Exit codes: 0 done, 1 failed, 2 preflight or lock, 130 interrupted.

## After a crash or `kill -9`

A run that cannot tear down, such as one killed with SIGKILL, leaves its ledger behind, and the next run or dry run reports it. Run:

```bash
uv run python -m tests.screenshots --cleanup
```

It loads every ledger entry, adds every container and network labelled `geometrikks.screenshots.run` and the reserved database, and removes them. It also stops stray processes from an earlier capture and removes leftover dry-run folders. Before it removes anything, it writes the labelled resources and the database it found into the ledger, so whatever it cannot remove stays listed for the next try. It exits 0 and prints `cleanup: nothing left` only when everything is gone. It exits 1 when it could not list the labelled resources, could not reach the database server, could not remove something, or could not repair an interrupted publish. A dry-run folder whose processes it could not stop stays, and the output names it. If the ledger is unreadable, it says so, leaves the file for you to read and delete, still removes the labelled resources and the database, and exits 1.

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
- `ip-inspector` opens 198.51.100.14. The header shows the ASN with no flag or city, the locations block is empty, and the map behind the sheet keeps its view, since the address has no marker.
- `abuse-report` for 198.51.100.14 names the network as `AS64496 Fictional Example Hosting` with no country code. Its DROP notice covers both the v4 listing and the ASN-DROP listing.

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
