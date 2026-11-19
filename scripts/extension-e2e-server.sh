#!/usr/bin/env bash
# Serves a seeded scratch GeoMetrikks over HTTPS on this machine's LAN address,
# for the extension's e2e tests. It runs until Ctrl-C, then stops the server and
# drops the scratch database. Set KEEP_DB=1 to keep the database.
#
#   scripts/extension-e2e-server.sh
#   source "${TMPDIR:-/tmp}/geometrikks-ext-e2e/keys.env"   # in another shell
#
# Needs the TimescaleDB container from docker-compose, named by E2E_DB_CONTAINER,
# and the main checkout's GeoLite2 files in E2E_GEOIP_DIR.
set -euo pipefail

cd "$(dirname "$0")/.."

DB=geometrikks_ext_e2e
DB_CONTAINER="${E2E_DB_CONTAINER:-timescale_db}"
DB_USER="${DB_USER:-geouser}"
GEOIP_DIR="${E2E_GEOIP_DIR:-$HOME/dev/geometrikks/data/geoip}"
SOURCE_ENV="${E2E_SOURCE_ENV:-$HOME/dev/geometrikks/.env}"
PORT="${E2E_PORT:-8443}"
LAN_IP="${E2E_LAN_IP:-$(hostname -I | awk '{print $1}')}"
ORIGIN="https://$LAN_IP:$PORT"
WORK="${TMPDIR:-/tmp}/geometrikks-ext-e2e"
mkdir -p "$WORK"

psql_admin() {
  docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -q -U "$DB_USER" -d postgres "$@"
}
psql_scratch() {
  docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -q -At -U "$DB_USER" -d "$DB" "$@"
}

if ss -ltn "sport = :$PORT" | grep -q LISTEN; then
  echo "Port $PORT is in use; stop that server first." >&2
  exit 1
fi

# No CrowdSec machine credentials, so no ban can reach the real LAPI, and no keys
# for services that spend a quota or download anything.
if [[ -f "$SOURCE_ENV" ]]; then
  grep -v -E "^(CROWDSEC_MACHINE_(ID|PASSWORD)|ABUSEIPDB_API_KEY|MAXMINDDB_[A-Z_]+|LOGPARSER_[A-Z_]+|APP_URL|DB_[A-Z_]+)=" \
    "$SOURCE_ENV" >"$WORK/server.env"
else
  : >"$WORK/server.env"
fi
export GEOMETRIKKS_ENV_FILE="$WORK/server.env"
export DB_DATABASE="$DB"
export APP_ADMIN_USER=admin APP_ADMIN_PASSWORD=admin APP_URL="$ORIGIN"
export VITE_DEV_MODE=false LOGPARSER_ENABLED=false SCHEDULER_ENABLED=false
export GEOIP_DB_PATH="$GEOIP_DIR/GeoLite2-City.mmdb" GEOIP_ASN_DB_PATH="$GEOIP_DIR/GeoLite2-ASN.mmdb"

openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=$LAN_IP" \
  -addext "subjectAltName=IP:$LAN_IP" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null

psql_admin -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"

SERVER_PID=""
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -INT "$SERVER_PID"
    for _ in $(seq 1 40); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "${KEEP_DB:-0}" != 1 ]]; then
    psql_admin -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" && echo "Dropped $DB."
  fi
  rm -f "$WORK/keys.env" "$WORK/server.env" "$WORK/key.pem" "$WORK/cert.pem"
}
trap cleanup EXIT INT TERM

.venv/bin/uvicorn --factory geometrikks.server.core:create_app \
  --host 0.0.0.0 --port "$PORT" \
  --ssl-keyfile "$WORK/key.pem" --ssl-certfile "$WORK/cert.pem" \
  >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

echo "Starting GeoMetrikks on $ORIGIN (log: $WORK/server.log)"
for _ in $(seq 1 120); do
  curl -fsk "$ORIGIN/health/ready" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -40 "$WORK/server.log" >&2; exit 1; }
  sleep 1
done
curl -fsk "$ORIGIN/health/ready" >/dev/null

# The server ran the migrations; never seed a database without them.
[[ "$(psql_scratch -c "SELECT to_regclass('public.access_logs') IS NOT NULL")" == t ]] || {
  echo "$DB has no access_logs table" >&2
  exit 1
}

uv run python -m tests.seed --rows 30000 --days 10 \
  --city-db "$GEOIP_DIR/GeoLite2-City.mmdb" --asn-db "$GEOIP_DIR/GeoLite2-ASN.mmdb"

# The site the popup tests open. Site stats read raw rows, so moving one seeded
# host's rows is enough.
psql_scratch -c "UPDATE access_logs SET host = 'photos.example.net' WHERE host = 'media.example.com'"
echo "photos.example.net rows: $(psql_scratch -c "SELECT count(*) FROM access_logs WHERE host = 'photos.example.net'")"

JAR="$WORK/cookies.txt"
curl -fsk -c "$JAR" -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin"}' "$ORIGIN/api/v1/auth/login" >/dev/null
make_key() {
  curl -fsk -b "$JAR" -H 'content-type: application/json' \
    -d "{\"name\":\"$1\",\"scope\":\"$2\"}" "$ORIGIN/api/v1/auth/api-keys" |
    uv run python -c 'import json, sys; print(json.load(sys.stdin)["key"])'
}
RW_KEY="$(make_key "e2e read-write" read_write)"
READ_KEY="$(make_key "e2e read" read)"
rm -f "$JAR"

cat >"$WORK/keys.env" <<EOF
export E2E_ORIGIN=$ORIGIN
export E2E_RW_KEY=$RW_KEY
export E2E_READ_KEY=$READ_KEY
EOF
echo
echo "Ready. In another shell:"
echo "  source $WORK/keys.env"
echo "  bun run ext:build:e2e && bun run ext:test:e2e"
echo "Ctrl-C stops the server and drops $DB."
wait "$SERVER_PID"
