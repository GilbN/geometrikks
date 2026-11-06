"""Static vocabulary the traffic generator draws from: sites, agents, probes, statuses."""

from __future__ import annotations

import random
from typing import Final

Weighted = tuple[tuple[str, float], ...]


def pick_weighted[T](rng: random.Random, options: tuple[tuple[T, float], ...]) -> T:
    return rng.choices([value for value, _ in options], [weight for _, weight in options])[0]

BROWSER_USER_AGENTS: Final[Weighted] = (
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36", 26),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36", 9),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0", 7),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0", 6),
    ("Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0", 3),
    ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36", 2),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15", 8),
    ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1", 18),
    ("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36", 17),
    ("Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1", 3),
)

SCANNER_USER_AGENTS: Final[tuple[tuple[str | None, float], ...]] = (
    (None, 20),
    ("Mozilla/5.0 zgrab/0.x", 12),
    ("Mozilla/5.0 (compatible; CensysInspect/1.1; +https://about.censys.io/)", 8),
    ("Mozilla/5.0 (l9scan/2.0.130313e2834313e2735323e2334323; +https://leakix.net)", 4),
    ("masscan/1.3 (https://github.com/robertdavidgraham/masscan)", 3),
    ("python-requests/2.32.5", 9),
    ("Go-http-client/1.1", 10),
    ("curl/8.7.1", 5),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36", 14),
    ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/78.0.3904.108 Safari/537.36", 8),
)

# (name, user agent, address ranges the crawler really uses or None for "any datacenter IP")
CRAWLERS: Final[tuple[tuple[str, str, tuple[str, ...] | None], ...]] = (
    ("googlebot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", ("66.249.64.0/19",)),
    (
        "bingbot",
        "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
        ("157.55.39.0/24", "40.77.167.0/24", "207.46.13.0/24"),
    ),
    ("yandexbot", "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", ("213.180.192.0/19",)),
    (
        "applebot",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) "
        "Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
        ("17.241.0.0/16",),
    ),
    ("ahrefsbot", "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", None),
    ("gptbot", "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", None),
)

# Virtual hosts and the pages people actually open on them. Hosts are spread
# over the seeded servers round-robin, so each server owns a few of them.
SITES: Final[dict[str, Weighted]] = {
    "example.com": (
        ("/", 30), ("/about", 4), ("/blog/", 8), ("/blog/self-hosting-geoip", 5),
        ("/blog/homelab-tour-2026", 4), ("/feed.xml", 6), ("/assets/app.css", 10),
        ("/assets/app.js", 10), ("/images/hero.webp", 6), ("/favicon.ico", 8),
    ),
    "cloud.example.com": (
        ("/login", 6), ("/index.php/apps/files/", 12), ("/remote.php/dav/files/alex/", 25),
        ("/ocs/v2.php/apps/notifications/api/v2/notifications", 15), ("/status.php", 6),
        ("/index.php/apps/photos/", 5),
    ),
    "media.example.com": (
        ("/web/", 10), ("/Users/AuthenticateByName", 3), ("/Items", 14),
        ("/Sessions/Playing/Progress", 12), ("/socket", 6), ("/System/Info/Public", 5),
    ),
    "git.example.com": (
        ("/", 6), ("/alex/dotfiles", 5), ("/alex/homelab/src/branch/main/README.md", 4),
        ("/api/v1/repos/search", 3), ("/user/login", 3), ("/assets/css/index.css", 4),
    ),
    "status.example.com": (("/", 10), ("/api/status-page/heartbeat/main", 20), ("/api/push/k8Jd2", 6)),
    "auth.example.com": (
        ("/", 4), ("/api/verify", 30), ("/api/state", 6), ("/api/firstfactor", 3), ("/static/js/index.js", 3),
    ),
    "home.example.com": (
        ("/", 6), ("/api/websocket", 10), ("/api/states", 6), ("/auth/token", 2), ("/frontend_latest/app.js", 3),
    ),
}

CRAWLER_PATHS: Final[Weighted] = (("/robots.txt", 18), ("/sitemap.xml", 8), ("/", 20), ("/feed.xml", 4))

# (method, path, weight)
SCANNER_REQUESTS: Final[tuple[tuple[str, str, float], ...]] = (
    ("GET", "/", 20),
    ("GET", "/.env", 10),
    ("GET", "/.git/config", 7),
    ("GET", "/wp-login.php", 8),
    ("GET", "/wp-admin/setup-config.php", 3),
    ("GET", "/xmlrpc.php", 3),
    ("POST", "/xmlrpc.php", 2),
    ("GET", "/phpmyadmin/index.php", 3),
    ("GET", "/admin/config.php", 2),
    ("GET", "/.aws/credentials", 3),
    ("GET", "/server-status", 2),
    ("GET", "/actuator/health", 3),
    ("GET", "/actuator/env", 2),
    ("POST", "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", 3),
    ("GET", "/cgi-bin/luci/;stok=/locale", 2),
    ("POST", "/boaform/admin/formLogin", 2),
    ("GET", "/HNAP1/", 2),
    ("GET", "/owa/auth/logon.aspx", 2),
    ("GET", "/manager/html", 2),
    ("GET", "/geoserver/web/", 2),
    ("GET", "/developmentserver/metadatauploader", 1),
    ("GET", "/.DS_Store", 2),
    ("GET", "/config.json", 2),
    ("GET", "/api/v1/pods", 1),
    ("GET", "/telescope/requests", 1),
    ("GET", "/favicon.ico", 4),
    ("GET", "/robots.txt", 3),
    ("HEAD", "/", 3),
    ("OPTIONS", "/", 1),
    ("PROPFIND", "/", 1),
)

SEARCH_REFERRERS: Final[Weighted] = (
    ("https://www.google.com/", 60), ("https://duckduckgo.com/", 12), ("https://www.bing.com/", 8),
    ("https://news.ycombinator.com/", 4), ("https://www.reddit.com/", 6), ("https://github.com/", 5),
)

BROWSER_METHODS: Final[Weighted] = (("GET", 88), ("POST", 7), ("PUT", 2), ("HEAD", 1), ("OPTIONS", 1), ("DELETE", 1))

STATUSES: Final[dict[str, tuple[tuple[int, float], ...]]] = {
    "browser": (
        (200, 80), (304, 8), (206, 1), (301, 1.5), (302, 1.5), (404, 3), (401, 1.5),
        (403, 0.8), (499, 0.6), (500, 0.4), (502, 1), (503, 0.4), (504, 0.3),
    ),
    "crawler": ((200, 78), (301, 8), (304, 5), (404, 8), (410, 1)),
    "scanner": ((404, 55), (403, 12), (400, 8), (301, 8), (200, 8), (401, 4), (405, 3), (444, 2)),
}

HTTP_VERSIONS: Final[Weighted] = (("HTTP/2.0", 55), ("HTTP/1.1", 40), ("HTTP/3.0", 5))

# Probe payloads as each format logs them, with the parse_error ingestion
# assigns to the line. nginx's default escaping writes bytes as \xNN text;
# escape=json writes \u00NN, which the JSON decoder turns back into bytes.
PROBES: Final[dict[str, tuple[tuple[str, str], ...]]] = {
    "nginx": (
        (
            r"\x16\x03\x01\x00\xEE\x01\x00\x00\xEA\x03\x03\x9Fl\xB2\x8C\x1A\x04\xD7",
            "TLS handshake sent to HTTP port (escaped)",
        ),
        ("SSH-2.0-Go", "SSH probe sent to HTTP port"),
        (r"\x00\x00\x00\x85\xFFSMBr\x00\x00\x00\x00\x18S\xC8", "SMB protocol probe (EternalBlue scanner)"),
    ),
    "geometrikks-json": (
        ("\x16\x03\x01\x00\xee\x01\x00\x00\xea\x03\x03\x9fl\xb2", "TLS handshake sent to HTTP port (raw)"),
        ("SSH-2.0-Go", "SSH probe sent to HTTP port"),
        ("\x00\x00\x00\x85\xffSMBr\x00\x00\x00\x00", "SMB protocol probe (EternalBlue scanner)"),
    ),
}

LOG_FORMATS: Final[tuple[str, ...]] = ("geometrikks-json", "nginx")

UNPARSEABLE_LINES: Final[tuple[str, ...]] = (
    "\x16\x03\x01\x02\ufffd\x01\ufffd\x01\xfc\x03\x03",
    '- - - [-] "-" 000 0 "-" "-"',
    "GET / HTTP/1.1",
    "<html><head><title>400 Bad Request</title></head>",
)

# Real coordinates for server beacons on the map, assigned in order.
SERVER_SITES: Final[tuple[tuple[float, float], ...]] = (
    (50.1109, 8.6821),  # Frankfurt
    (59.9139, 10.7522),  # Oslo
    (52.3676, 4.9041),  # Amsterdam
    (39.0438, -77.4874),  # Ashburn
    (60.1699, 24.9384),  # Helsinki
    (1.3521, 103.8198),  # Singapore
)

# Regional IPv6 allocations (RIPE, ARIN, APNIC, LACNIC, AFRINIC); a random
# address in all of 2000::/3 almost never resolves.
IPV6_POOLS: Final[tuple[str, ...]] = ("2a00::/12", "2600::/12", "2400::/12", "2800::/12", "2c00::/12")
