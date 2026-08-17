import { describe, expect, it } from "vitest"
import { beaconLabel, buildHomeResolver, homeBeacons } from "@/lib/site-homes"

const DATA = {
  homes: [
    { hostname: "nginx-01", latitude: 59.91, longitude: 10.75 },
    { hostname: "traefik-01", latitude: 60.39, longitude: 5.32 },
  ],
  default: { latitude: 59.91, longitude: 10.75 },
}

describe("buildHomeResolver", () => {
  it("resolves a known hostname to [lng, lat]", () => {
    expect(buildHomeResolver(DATA)("traefik-01")).toEqual([5.32, 60.39])
  })
  it("falls back to the default for unknown or null hostnames", () => {
    expect(buildHomeResolver(DATA)("mystery")).toEqual([10.75, 59.91])
    expect(buildHomeResolver(DATA)(null)).toEqual([10.75, 59.91])
  })
  it("returns null with no data and no default", () => {
    expect(buildHomeResolver(undefined)("x")).toBeNull()
    expect(buildHomeResolver({ homes: [], default: null })("x")).toBeNull()
  })
})

describe("homeBeacons", () => {
  it("dedupes coincident homes, carrying their hostnames", () => {
    expect(homeBeacons(DATA)).toEqual([
      { coordinate: [10.75, 59.91], hostnames: ["nginx-01"] },
      { coordinate: [5.32, 60.39], hostnames: ["traefik-01"] },
    ])
  })
  it("keeps a distinct default as a hostname-less beacon", () => {
    const data = {
      homes: [{ hostname: "nginx-01", latitude: 60.39, longitude: 5.32 }],
      default: { latitude: 59.91, longitude: 10.75 },
    }
    expect(homeBeacons(data)).toEqual([
      { coordinate: [10.75, 59.91], hostnames: [] },
      { coordinate: [5.32, 60.39], hostnames: ["nginx-01"] },
    ])
  })
  it("is empty with no data", () => {
    expect(homeBeacons(undefined)).toEqual([])
  })
})

describe("beaconLabel", () => {
  it("names the sites at the coordinate", () => {
    expect(beaconLabel({ coordinate: [1, 2], hostnames: ["nginx-01"] })).toBe(
      "Site location: nginx-01",
    )
    expect(beaconLabel({ coordinate: [1, 2], hostnames: ["a", "b"] })).toBe(
      "Site location: a, b",
    )
  })
  it("labels a hostname-less beacon as the server location", () => {
    expect(beaconLabel({ coordinate: [1, 2], hostnames: [] })).toBe("Server location")
  })
})
