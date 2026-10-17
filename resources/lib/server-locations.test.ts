import { describe, expect, it } from "vitest"
import { beaconLabel, buildServerLocationResolver, serverBeacons } from "@/lib/server-locations"

const DATA = {
  locations: [
    { server: "nginx-01", latitude: 59.91, longitude: 10.75 },
    { server: "traefik-01", latitude: 60.39, longitude: 5.32 },
  ],
  default: { latitude: 59.91, longitude: 10.75 },
}

describe("buildServerLocationResolver", () => {
  it("resolves a known server to [lng, lat]", () => {
    expect(buildServerLocationResolver(DATA)("traefik-01")).toEqual([5.32, 60.39])
  })
  it("falls back to the default for unknown or null servers", () => {
    expect(buildServerLocationResolver(DATA)("mystery")).toEqual([10.75, 59.91])
    expect(buildServerLocationResolver(DATA)(null)).toEqual([10.75, 59.91])
  })
  it("returns null with no data and no default", () => {
    expect(buildServerLocationResolver(undefined)("x")).toBeNull()
    expect(buildServerLocationResolver({ locations: [], default: null })("x")).toBeNull()
  })
})

describe("serverBeacons", () => {
  it("dedupes coincident locations, carrying their servers", () => {
    expect(serverBeacons(DATA)).toEqual([
      { coordinate: [10.75, 59.91], servers: ["nginx-01"] },
      { coordinate: [5.32, 60.39], servers: ["traefik-01"] },
    ])
  })
  it("keeps a distinct default as a beacon without servers", () => {
    const data = {
      locations: [{ server: "nginx-01", latitude: 60.39, longitude: 5.32 }],
      default: { latitude: 59.91, longitude: 10.75 },
    }
    expect(serverBeacons(data)).toEqual([
      { coordinate: [10.75, 59.91], servers: [] },
      { coordinate: [5.32, 60.39], servers: ["nginx-01"] },
    ])
  })
  it("is empty with no data", () => {
    expect(serverBeacons(undefined)).toEqual([])
  })
})

describe("beaconLabel", () => {
  it("names the servers at the coordinate", () => {
    expect(beaconLabel({ coordinate: [1, 2], servers: ["nginx-01"] })).toBe(
      "Server location: nginx-01",
    )
    expect(beaconLabel({ coordinate: [1, 2], servers: ["edge-01", "nas"] })).toBe(
      "Server location: edge-01, nas",
    )
  })
  it("labels a beacon without servers as the server location", () => {
    expect(beaconLabel({ coordinate: [1, 2], servers: [] })).toBe("Server location")
  })
})
