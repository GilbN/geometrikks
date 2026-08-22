import { describe, expect, it } from "vitest"
import type { AccessLogData, GeoEventData, LiveEvent } from "@/lib/websocket"
import { matchesSources, toLiveRequests } from "./requests"
import type { LiveRequest } from "./types"

const TS = "2026-07-22T19:57:54+02:00"

function geoData(ip: string, hostname = "vps-1"): GeoEventData {
  return {
    timestamp: TS,
    ip_address: ip,
    latitude: 59.9133,
    longitude: 10.7389,
    city: "Oslo",
    country_code: "NO",
    hostname,
  }
}

function logData(ip: string, status: number, hostname = "vps-1"): AccessLogData {
  return {
    timestamp: TS,
    ip_address: ip,
    remote_user: null,
    method: "GET",
    url: "/map",
    http_version: "HTTP/2.0",
    status_code: status,
    bytes_sent: 903,
    referrer: null,
    user_agent: "curl/8.4.0",
    request_time: 0.204,
    upstream_response_time: 0.026,
    host: "geometrikks.example.com",
    country_code: "NO",
    country_name: "Norway",
    city: "Oslo",
    autonomous_system_number: 2119,
    autonomous_system_organization: "Telenor Norge AS",
    hostname,
  }
}

function envelope(geo: GeoEventData | null, log: AccessLogData | null): LiveEvent {
  return { type: "request", geo, log }
}

describe("toLiveRequests", () => {
  it("flattens a full envelope into one request", () => {
    const requests = toLiveRequests(
      [envelope(geoData("1.1.1.1"), logData("1.1.1.1", 200))],
      new Set(),
      1000,
    )

    expect(requests).toHaveLength(1)
    expect(requests[0].coordinates).toEqual([10.7389, 59.9133])
    expect(requests[0].log?.status_code).toBe(200)
    expect(requests[0].statusClass).toBe("2xx")
  })

  it("keeps a geo-only envelope, with no detail", () => {
    const requests = toLiveRequests([envelope(geoData("1.1.1.1"), null)], new Set(), 1000)

    expect(requests).toHaveLength(1)
    expect(requests[0].log).toBeNull()
    expect(requests[0].statusClass).toBe("unknown")
    expect(requests[0].coordinates).not.toBeNull()
  })

  it("keeps a log-only envelope, with no coordinates", () => {
    const requests = toLiveRequests([envelope(null, logData("1.1.1.1", 404))], new Set(), 1000)

    expect(requests).toHaveLength(1)
    expect(requests[0].coordinates).toBeNull()
    expect(requests[0].statusClass).toBe("4xx")
    expect(requests[0].city).toBe("Oslo")
  })

  it("skips an empty envelope", () => {
    expect(toLiveRequests([envelope(null, null)], new Set(), 1000)).toEqual([])
  })

  it("keeps records from different sites sharing an IP and second distinct", () => {
    // Two agents seeing the same client in the same second: each record is
    // whole on arrival, whatever the publish interleaving was.
    const requests = toLiveRequests(
      [
        envelope(geoData("1.1.1.1", "nginx-01"), logData("1.1.1.1", 200, "nginx-01")),
        envelope(geoData("1.1.1.1", "traefik-01"), logData("1.1.1.1", 404, "traefik-01")),
      ],
      new Set(),
      1000,
    )

    expect(requests).toHaveLength(2)
    expect(requests[0].hostname).toBe("nginx-01")
    expect(requests[0].log?.status_code).toBe(200)
    expect(requests[1].hostname).toBe("traefik-01")
    expect(requests[1].log?.status_code).toBe(404)
  })

  it("gives every request in a batch a distinct id", () => {
    const requests = toLiveRequests(
      [
        envelope(geoData("1.1.1.1"), logData("1.1.1.1", 200)),
        envelope(geoData("1.1.1.1"), logData("1.1.1.1", 404)),
      ],
      new Set(),
      1000,
    )

    expect(new Set(requests.map((r) => r.id)).size).toBe(2)
  })

  it("marks banned IPs and makes them threats whatever their status", () => {
    const requests = toLiveRequests(
      [envelope(geoData("9.9.9.9"), logData("9.9.9.9", 200))],
      new Set(["9.9.9.9"]),
      1000,
    )

    expect(requests[0].banned).toBe(true)
    expect(requests[0].threat).toBe(true)
  })

  it("marks a 5xx as an error but not a threat", () => {
    const requests = toLiveRequests(
      [envelope(geoData("1.1.1.1"), logData("1.1.1.1", 502))],
      new Set(),
      1000,
    )

    expect(requests[0].statusClass).toBe("5xx")
    expect(requests[0].threat).toBe(false)
  })

  it("marks a refused request as a threat but leaves a 404 alone", () => {
    const requests = toLiveRequests(
      [
        envelope(geoData("1.1.1.1"), logData("1.1.1.1", 403)),
        envelope(geoData("2.2.2.2"), logData("2.2.2.2", 404)),
      ],
      new Set(),
      1000,
    )

    expect(requests[0].threat).toBe(true)
    // Both are 4xx on the map and in the response mix; only one is a threat.
    expect(requests[1].statusClass).toBe("4xx")
    expect(requests[1].threat).toBe(false)
  })

  it("returns nothing for an empty heartbeat frame", () => {
    expect(toLiveRequests([], new Set(), 1000)).toEqual([])
  })

  it("carries the recording hostname from either side of the envelope", () => {
    const geoOnly = toLiveRequests([envelope(geoData("1.1.1.1"), null)], new Set(), 1000)
    const logOnly = toLiveRequests([envelope(null, logData("2.2.2.2", 200))], new Set(), 1000)

    expect(geoOnly[0].hostname).toBe("vps-1")
    expect(logOnly[0].hostname).toBe("vps-1")
  })
})

function requestWithHostname(hostname: string | null): LiveRequest {
  return {
    id: "r",
    timestamp: TS,
    receivedAt: 0,
    ip: "1.1.1.1",
    coordinates: null,
    city: null,
    countryCode: null,
    log: null,
    statusClass: "unknown",
    banned: false,
    threat: false,
    hostname,
  }
}

describe("matchesSources", () => {
  it("passes everything when no sources are selected", () => {
    expect(matchesSources(requestWithHostname("nginx-01"), [])).toBe(true)
    expect(matchesSources(requestWithHostname(null), [])).toBe(true)
  })

  it("filters by exact hostname", () => {
    expect(matchesSources(requestWithHostname("nginx-01"), ["nginx-01"])).toBe(true)
    expect(matchesSources(requestWithHostname("nginx-01"), ["traefik-01"])).toBe(false)
  })

  it("drops hostname-less requests when a filter is active", () => {
    expect(matchesSources(requestWithHostname(null), ["nginx-01"])).toBe(false)
  })
})
