import { describe, expect, it } from "vitest"
import { decodeMapSearch, encodeMapSearch } from "@/lib/map-filters"

describe("map filter codec", () => {
  it("decodes absent params to empty arrays", () => {
    expect(decodeMapSearch({})).toEqual({ sources: [], countryCodes: [], cities: [] })
  })
  it("round-trips selections and drops empties from the URL", () => {
    const filters = { sources: ["nginx-01"], countryCodes: ["NO", "DE"], cities: [] }
    const encoded = encodeMapSearch(filters)
    expect(encoded).toEqual({ sources: ["nginx-01"], countries: ["NO", "DE"], cities: undefined })
    expect(decodeMapSearch(encoded)).toEqual(filters)
  })
  it("leaves focus and demoTraffic alone when encoding filters", () => {
    const prev = { focus: 12, demoTraffic: "1" }
    const next = { ...prev, ...encodeMapSearch({ sources: [], countryCodes: ["NO"], cities: [] }) }
    expect(next).toEqual({ focus: 12, demoTraffic: "1", sources: undefined, countries: ["NO"], cities: undefined })
  })
})
