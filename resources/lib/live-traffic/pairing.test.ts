import { describe, expect, it } from "vitest"
import type { LiveEvent } from "@/lib/websocket"
import { pairLiveEvents } from "./pairing"

const TS = "2026-07-22T19:57:54+02:00"

function geo(ip: string, timestamp = TS): LiveEvent {
  return {
    type: "geo_event",
    data: {
      timestamp,
      ip_address: ip,
      latitude: 59.9133,
      longitude: 10.7389,
      city: "Oslo",
      country_code: "NO",
    },
  }
}

function log(ip: string, status: number, timestamp = TS): LiveEvent {
  return {
    type: "access_log",
    data: {
      timestamp,
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
    },
  }
}

describe("pairLiveEvents", () => {
  it("joins a geo event with the access log that follows it", () => {
    const requests = pairLiveEvents([geo("1.1.1.1"), log("1.1.1.1", 200)], new Set(), 1000)

    expect(requests).toHaveLength(1)
    expect(requests[0].coordinates).toEqual([10.7389, 59.9133])
    expect(requests[0].log?.status_code).toBe(200)
    expect(requests[0].statusClass).toBe("2xx")
  })

  it("keeps a geo event that has no log line, with no detail", () => {
    const requests = pairLiveEvents([geo("1.1.1.1")], new Set(), 1000)

    expect(requests).toHaveLength(1)
    expect(requests[0].log).toBeNull()
    expect(requests[0].statusClass).toBe("unknown")
    expect(requests[0].coordinates).not.toBeNull()
  })

  it("keeps a log line that has no geo event, with no coordinates", () => {
    const requests = pairLiveEvents([log("1.1.1.1", 404)], new Set(), 1000)

    expect(requests).toHaveLength(1)
    expect(requests[0].coordinates).toBeNull()
    expect(requests[0].statusClass).toBe("4xx")
    expect(requests[0].city).toBe("Oslo")
  })

  it("does not pair events from different IPs that happen to be adjacent", () => {
    const requests = pairLiveEvents([geo("1.1.1.1"), log("2.2.2.2", 200)], new Set(), 1000)

    expect(requests).toHaveLength(2)
    expect(requests[0].log).toBeNull()
    expect(requests[1].coordinates).toBeNull()
  })

  it("does not pair events from the same IP at different timestamps", () => {
    const requests = pairLiveEvents(
      [geo("1.1.1.1"), log("1.1.1.1", 200, "2026-07-22T19:58:00+02:00")],
      new Set(),
      1000,
    )

    expect(requests).toHaveLength(2)
  })

  it("pairs two records from one IP in the same batch", () => {
    const requests = pairLiveEvents(
      [geo("1.1.1.1"), log("1.1.1.1", 200), geo("1.1.1.1"), log("1.1.1.1", 404)],
      new Set(),
      1000,
    )

    expect(requests).toHaveLength(2)
    expect(requests[0].log?.status_code).toBe(200)
    expect(requests[1].log?.status_code).toBe(404)
  })

  it("gives every request in a batch a distinct id", () => {
    const requests = pairLiveEvents(
      [geo("1.1.1.1"), log("1.1.1.1", 200), geo("1.1.1.1"), log("1.1.1.1", 404)],
      new Set(),
      1000,
    )

    expect(new Set(requests.map((r) => r.id)).size).toBe(2)
  })

  it("marks banned IPs and makes them threats whatever their status", () => {
    const requests = pairLiveEvents(
      [geo("9.9.9.9"), log("9.9.9.9", 200)],
      new Set(["9.9.9.9"]),
      1000,
    )

    expect(requests[0].banned).toBe(true)
    expect(requests[0].threat).toBe(true)
  })

  it("marks a 5xx as an error but not a threat", () => {
    const requests = pairLiveEvents([geo("1.1.1.1"), log("1.1.1.1", 502)], new Set(), 1000)

    expect(requests[0].statusClass).toBe("5xx")
    expect(requests[0].threat).toBe(false)
  })

  it("returns nothing for an empty heartbeat frame", () => {
    expect(pairLiveEvents([], new Set(), 1000)).toEqual([])
  })
})
