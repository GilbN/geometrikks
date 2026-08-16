import { describe, expect, it } from "vitest"
import { buildHomeResolver, homeBeacons } from "@/lib/site-homes"

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
  it("dedupes coincident homes and includes a distinct default once", () => {
    expect(homeBeacons(DATA)).toEqual([
      [10.75, 59.91],
      [5.32, 60.39],
    ])
  })
  it("is empty with no data", () => {
    expect(homeBeacons(undefined)).toEqual([])
  })
})
