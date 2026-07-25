import { describe, expect, it } from "vitest"
import { DEMO_TRAFFIC_ORIGINS, makeDemoRequests } from "./demo-traffic"

describe("makeDemoRequests", () => {
  it("makes the requested number of requests", () => {
    expect(makeDemoRequests(0, 4, 1000)).toHaveLength(4)
  })

  it("is deterministic for a given cursor", () => {
    const first = makeDemoRequests(3, 2, 1000)
    const second = makeDemoRequests(3, 2, 1000)

    expect(first.map((r) => r.log?.url)).toEqual(second.map((r) => r.log?.url))
    expect(first.map((r) => r.statusClass)).toEqual(second.map((r) => r.statusClass))
  })

  it("walks the origin list so routes vary", () => {
    const requests = makeDemoRequests(0, 3, 1000)
    const coordinates = requests.map((r) => r.coordinates)

    expect(coordinates[0]).toEqual(DEMO_TRAFFIC_ORIGINS[0].coordinates)
    expect(coordinates[1]).toEqual(DEMO_TRAFFIC_ORIGINS[1].coordinates)
    expect(coordinates[2]).toEqual(DEMO_TRAFFIC_ORIGINS[2].coordinates)
  })

  it("produces every status class across a full cycle", () => {
    const classes = new Set(makeDemoRequests(0, 100, 1000).map((r) => r.statusClass))

    expect(classes.has("2xx")).toBe(true)
    expect(classes.has("3xx")).toBe(true)
    expect(classes.has("4xx")).toBe(true)
    expect(classes.has("5xx")).toBe(true)
  })

  it("is mostly successful traffic", () => {
    const requests = makeDemoRequests(0, 100, 1000)
    const ok = requests.filter((r) => r.statusClass === "2xx").length

    expect(ok).toBeGreaterThan(60)
  })

  it("includes some banned IPs, and they are threats", () => {
    const banned = makeDemoRequests(0, 100, 1000).filter((r) => r.banned)

    expect(banned.length).toBeGreaterThan(0)
    expect(banned.every((r) => r.threat)).toBe(true)
  })

  it("gives every request an id, coordinates, and a log line", () => {
    const requests = makeDemoRequests(0, 20, 1000)

    expect(new Set(requests.map((r) => r.id)).size).toBe(20)
    expect(requests.every((r) => r.coordinates !== null)).toBe(true)
    expect(requests.every((r) => r.log !== null)).toBe(true)
  })
})
