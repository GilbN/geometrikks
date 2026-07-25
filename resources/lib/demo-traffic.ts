import { isThreat, statusClass } from "@/lib/live-traffic/classify"
import type { LiveRequest } from "@/lib/live-traffic/types"

export type DemoTrafficMode = "off" | "steady" | "burst"

export interface DemoTrafficOrigin {
  city: string
  countryCode: string
  coordinates: [longitude: number, latitude: number]
}

/** Deterministic global origins for visually exercising long and short routes. */
export const DEMO_TRAFFIC_ORIGINS: readonly DemoTrafficOrigin[] = [
  { city: "London", countryCode: "GB", coordinates: [-0.1276, 51.5072] },
  { city: "New York", countryCode: "US", coordinates: [-74.006, 40.7128] },
  { city: "São Paulo", countryCode: "BR", coordinates: [-46.6333, -23.5505] },
  { city: "Cape Town", countryCode: "ZA", coordinates: [18.4241, -33.9249] },
  { city: "Mumbai", countryCode: "IN", coordinates: [72.8777, 19.076] },
  { city: "Singapore", countryCode: "SG", coordinates: [103.8198, 1.3521] },
  { city: "Tokyo", countryCode: "JP", coordinates: [139.6917, 35.6895] },
  { city: "Sydney", countryCode: "AU", coordinates: [151.2093, -33.8688] },
  { city: "San Francisco", countryCode: "US", coordinates: [-122.4194, 37.7749] },
  { city: "Reykjavík", countryCode: "IS", coordinates: [-21.9426, 64.1466] },
] as const

/** Demo traffic can never be enabled in a production bundle. */
export function getDemoTrafficMode(): DemoTrafficMode {
  if (!import.meta.env.DEV) return "off"
  const value = new URLSearchParams(window.location.search).get("demoTraffic")
  if (value === "burst") return "burst"
  if (value === "1" || value === "true" || value === "steady") return "steady"
  return "off"
}

/**
 * A 100-entry status cycle: roughly 74 percent 2xx, 8 percent 3xx, 15 percent
 * 4xx, 3 percent 5xx. The 4xx share is mostly 404, the way real traffic is,
 * with a few refusals so the threat lane has something in it that is not just
 * a banned IP.
 */
const DEMO_STATUS_CYCLE: readonly number[] = Array.from({ length: 100 }, (_, index) => {
  if (index % 33 === 32) return 502
  if (index % 10 === 7) return 404
  if (index % 19 === 4) return 403
  if (index % 23 === 9) return 401
  if (index % 11 === 5) return 301
  return 200
})

const DEMO_PATHS: readonly string[] = [
  "/map",
  "/api/v1/geo-locations/top-ips",
  "/assets/index.js",
  "/api/v1/stats",
  "/access-logs",
]

const DEMO_PROBE_PATHS: readonly string[] = [
  "/wp-login.php",
  "/.env",
  "/admin/config.php",
  "/vendor/phpunit/phpunit/eval-stdin.php",
]

const DEMO_AGENTS: readonly string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0",
  "curl/8.4.0",
  "python-requests/2.32.3",
]

/**
 * Deterministic synthetic requests for dev demo mode. Every field the overlays
 * read is populated, so colours, sizes, strips, and the threat lane
 * can all be exercised without waiting for real scanners.
 */
export function makeDemoRequests(cursor: number, count: number, now: number): LiveRequest[] {
  const requests: LiveRequest[] = []

  for (let offset = 0; offset < count; offset += 1) {
    const step = cursor + offset
    const origin = DEMO_TRAFFIC_ORIGINS[step % DEMO_TRAFFIC_ORIGINS.length]
    const code = DEMO_STATUS_CYCLE[step % DEMO_STATUS_CYCLE.length]
    const banned = step % 17 === 3
    const probing = banned || (code >= 400 && code < 500)
    const url = probing
      ? DEMO_PROBE_PATHS[step % DEMO_PROBE_PATHS.length]
      : DEMO_PATHS[step % DEMO_PATHS.length]
    const status = statusClass(code)
    const ip = `203.0.113.${step % 254}`
    const timestamp = new Date(now).toISOString()

    requests.push({
      id: `demo-${step}`,
      timestamp,
      receivedAt: now,
      ip,
      coordinates: origin.coordinates,
      city: origin.city,
      countryCode: origin.countryCode,
      statusClass: status,
      banned,
      threat: isThreat(code, banned),
      log: {
        timestamp,
        ip_address: ip,
        remote_user: null,
        method: probing ? "POST" : "GET",
        url,
        http_version: "HTTP/2.0",
        status_code: code,
        bytes_sent: probing ? 412 : 500 + (step % 40) * 4200,
        referrer: null,
        user_agent: DEMO_AGENTS[step % DEMO_AGENTS.length],
        request_time: 0.004 + (step % 25) / 100,
        upstream_response_time: 0.002 + (step % 9) / 100,
        host: "geometrikks.example.com",
        country_code: origin.countryCode,
        country_name: null,
        city: origin.city,
      },
    })
  }

  return requests
}
