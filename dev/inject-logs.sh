#!/bin/bash
# Appends one synthetic nginx line and one traefik JSON line per second to
# nginx_logs/, with fresh timestamps and a rotating pool of real public IPs,
# so the agents compose stack (dev/docker-compose.agents.yml) has live
# traffic to ingest.
#
# Runs automatically as the compose stack's log-injector service (for the
# stack's lifetime; `down` stops it). Standalone usage, from the repo root:
#   ./dev/inject-logs.sh &            # runs for 30 minutes, then stops
#   touch dev/inject-logs.stop        # stop it early (also stops the service)
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STOPFILE="$REPO/dev/inject-logs.stop"
# 0 = no time cap, run until stopped (what the compose service sets).
MAX_SECONDS=${INJECT_MAX_SECONDS:-1800}

rm -f "$STOPFILE"
trap 'echo "injector stopped by signal after $i iterations"; exit 0' TERM INT

IPS=(8.8.8.8 1.1.1.1 81.2.69.142 91.198.174.192 185.60.216.35 34.71.167.225 104.28.42.7 197.248.21.8 133.242.187.207 200.160.2.3 77.88.55.242 129.226.3.47)
PATHS=(/ /api/v1/status /login /wp-login.php /assets/app.js /images/logo.png /feed.xml /admin /robots.txt /health)
METHODS=(GET GET GET GET POST GET HEAD GET)
STATUSES=(200 200 200 301 404 200 403 200 500 204)
AGENTS=("Mozilla/5.0 (X11; Linux x86_64) Firefox/141.0" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0" "curl/8.9.1")

i=0
while [ ! -f "$STOPFILE" ] && { [ "$MAX_SECONDS" -eq 0 ] || [ "$i" -lt "$MAX_SECONDS" ]; }; do
  ip=${IPS[$((RANDOM % ${#IPS[@]}))]}
  path=${PATHS[$((RANDOM % ${#PATHS[@]}))]}
  method=${METHODS[$((RANDOM % ${#METHODS[@]}))]}
  status=${STATUSES[$((RANDOM % ${#STATUSES[@]}))]}
  agent=${AGENTS[$((RANDOM % ${#AGENTS[@]}))]}
  bytes=$((RANDOM % 5000 + 100))
  nts=$(date +"%d/%b/%Y:%H:%M:%S %z")
  printf '%s - - [%s]"%s %s HTTP/2.0" %s %s"-" yourdomain.com "-""0.0%02d" "0.001""-" "-"\n' \
    "$ip" "$nts" "$method" "$path" "$status" "$bytes" "$((RANDOM % 90))" >> "$REPO/nginx_logs/nginx.log"

  ip=${IPS[$((RANDOM % ${#IPS[@]}))]}
  path=${PATHS[$((RANDOM % ${#PATHS[@]}))]}
  method=${METHODS[$((RANDOM % ${#METHODS[@]}))]}
  status=${STATUSES[$((RANDOM % ${#STATUSES[@]}))]}
  tts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  ttsn=$(date -u +"%Y-%m-%dT%H:%M:%S.%NZ")
  printf '{"ClientAddr":"%s:%s","ClientHost":"%s","ClientPort":"%s","ClientUsername":"-","DownstreamContentSize":%s,"DownstreamStatus":%s,"Duration":%s,"OriginContentSize":%s,"OriginDuration":0,"OriginStatus":%s,"Overhead":1200,"RequestAddr":"chat.gflix.app","RequestContentSize":0,"RequestCount":%s,"RequestHost":"chat.gflix.app","RequestMethod":"%s","RequestPath":"%s","RequestPort":"-","RequestProtocol":"HTTP/2.0","RequestScheme":"https","RetryAttempts":0,"StartLocal":"%s","StartUTC":"%s","TLSCipher":"TLS_AES_128_GCM_SHA256","TLSVersion":"1.3","entryPointName":"https","level":"info","msg":"","request_User-Agent":"%s","time":"%s"}\n' \
    "$ip" "$((RANDOM % 50000 + 1024))" "$ip" "$((RANDOM % 50000 + 1024))" "$bytes" "$status" "$((RANDOM % 90000 + 500))" "$bytes" "$status" "$((i + 1))" "$method" "$path" "$ttsn" "$ttsn" "$agent" "$tts" >> "$REPO/nginx_logs/traefik.log"

  i=$((i + 1))
  sleep 1
done
echo "injector stopped after $i iterations"
