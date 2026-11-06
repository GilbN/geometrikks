# Seed data

Fills a development database with traffic that looks like what live ingestion writes, so you can try the map, analytics, logs and IP views without real logs.

```bash
uv run python -m tests.seed                      # 100k requests over the last 30 days
uv run python -m tests.seed -r 1000000 -d 90     # a million requests over 90 days
uv run python -m tests.seed --reset --home-country NO
```

It writes to the database in your `DB_*` settings and prints its name before it starts. Run the app once first so the migrations and continuous aggregates exist.

## Where the locations come from

Visitor IPs are random public addresses, kept only when the GeoLite2 City database places them. Every marker therefore sits on a city MaxMind actually reports, with the state, postal code, timezone and ASN the app would have stored. An IP keeps its location, ASN and user agent for the whole run, so the IP inspector and the per-IP views stay consistent.

The seeder reads the same databases as the app (`GEOIP_DB_PATH` and `GEOIP_ASN_DB_PATH`). A fresh worktree has no `data/geoip`, so point it at your main checkout:

```bash
uv run python -m tests.seed \
  --city-db ~/dev/geometrikks/data/geoip/GeoLite2-City.mmdb \
  --asn-db ~/dev/geometrikks/data/geoip/GeoLite2-ASN.mmdb
```

Without the ASN database the rows get no ASN, and scanners and the crawlers without published ranges come from any network instead of hosting ones. The City database is required. The `*-Test.mmdb` fixtures in `tests/` cover too few addresses to sample from.

## What a run writes

- `access_logs` and `geo_events`, one of each per request, from public IPs GeoIP places. Ingestion writes no access log or geo event for LAN addresses, and the seeder has none.
- `geo_locations`, one row per distinct place.
- `access_log_debug`. Every TLS, SSH and SMB probe keeps its raw line, linked to its access log. So does `--debug-share` of normal requests, and a few lines that never parsed.
- `server_locations`, a map beacon per server name (Frankfurt, then Oslo, Amsterdam and so on). Existing beacons stay as they are.

Then it refreshes the continuous aggregates over the seeded range and sets `geo_locations.last_hit`, the work the scheduler would otherwise do over the next six hours.

The traffic has three kinds of visitor:

- People hit one to three of the `*.example.com` hosts, mostly during their local daytime, for a few hours to the whole range.
- Crawlers such as Googlebot and bingbot come from their real address ranges and visit steadily.
- Scanners come from hosting ASNs in bursts of ten minutes to six hours. They probe `/.env`, `/wp-login.php` and the like and mostly get 404s.

A few visitors produce most of the requests (a Zipf split), so the top lists look like a real server's.

Each server name owns a share of the hosts and one log format. The first is `geometrikks-json`, the second `nginx`, and so on alternating. The default servers are `seed-edge` and `seed-nas`. Use `--servers` to name your own, for example to match `LOGPARSER_SERVER_NAME`.

## Options

| Option | Default | |
|---|---|---|
| `-r`, `--rows` | 100000 | Requests to write |
| `-d`, `--days` | 30 | Days of history, ending now |
| `--visitors` | rows / 40 | Distinct client IPs, 100 to 20000 |
| `--servers` | `seed-edge,seed-nas` | Server names, comma-separated |
| `--home-country` | none | ISO code that 40% of people come from |
| `-s`, `--seed` | 42 | The same seed and GeoLite2 build give the same visitors |
| `--debug-share` | 0.02 | Share of normal requests that keep a raw line |
| `--batch-size` | 20000 | Rows per COPY |
| `--reset` | off | Empty every traffic table and aggregate first. Asks you to type the database name unless you pass `-y` |
| `--no-refresh` | off | Skip the aggregate refresh. The refresh policies cover only the last three hours of hourly aggregates and three days of daily ones, so older seeded rows stay out of aggregate-backed charts until the app's next full refresh, which runs every six hours |
| `--database-url` | `DB_*` | Another database, as a `postgresql+asyncpg://` URL |

`--reset` wipes all of `access_logs`, `geo_events`, `access_log_debug`, `geo_locations` and the import history in `import_jobs` and `loki_imports`, real data included. It then refreshes the aggregates over all time, which drops their old buckets. Don't point it at a database you care about. Stop the app first, too. A running app holds location ids from before the reset, and its next batch fails until it reloads them.

Retention still applies: 180 days for raw rows, 60 for hourly aggregates and 30 for debug lines by default. If `--days` reaches past them, the next retention job drops the oldest seeded rows.

## Speed

On the dev box, 100k requests take about 30 seconds, half of it refreshing the aggregates. Each batch goes in through COPY in one transaction, so a failed run never leaves a batch's geo events without their access logs.

## Layout

| File | |
|---|---|
| `__main__.py` | Command line |
| `config.py` | `SeedConfig` |
| `visitors.py` | IP sampling and GeoLite2 lookups |
| `traffic.py` | Turns visitors into access log, geo event and debug rows |
| `catalog.py` | Hosts, paths, user agents, probe payloads, status mixes |
| `writer.py` | COPY, reset, location upserts |
| `seeder.py` | `run_seed`, which ties the steps together |

`tests/test_seed_traffic.py` checks the generated rows without a database. `tests/integration/test_seed_pg.py` seeds the scratch TimescaleDB, so a schema change that breaks the seeder fails CI.
