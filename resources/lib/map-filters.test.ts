import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router"
import { describe, expect, it } from "vitest"
import { decodeMapSearch, encodeMapSearch, flyToSearch, mapSearchSchema } from "@/lib/map-filters"

describe("map filter codec", () => {
  it("decodes absent params to empty arrays", () => {
    expect(decodeMapSearch({})).toEqual({ servers: [], countryCodes: [], cities: [] })
  })
  it("round-trips selections and drops empties from the URL", () => {
    const filters = { servers: ["nginx-01"], countryCodes: ["NO", "DE"], cities: [] }
    const encoded = encodeMapSearch(filters)
    expect(encoded).toEqual({ server: ["nginx-01"], countries: ["NO", "DE"], cities: undefined })
    expect(decodeMapSearch(encoded)).toEqual(filters)
  })
  it("decodes repeated server params into the server filter", () => {
    const search = mapSearchSchema.parse(defaultParseSearch("?server=a&server=b"))
    expect(decodeMapSearch(search).servers).toEqual(["a", "b"])
  })
  it("ignores the retired sources param", () => {
    for (const query of [defaultStringifySearch({ sources: ["a"] }), "?sources=a&sources=b"]) {
      const search = mapSearchSchema.parse(defaultParseSearch(query))
      expect(decodeMapSearch(search)).toEqual({ servers: [], countryCodes: [], cities: [] })
    }
  })
})

describe("map search schema", () => {
  it("coerces a numeric focus string to a positive integer", () => {
    expect(mapSearchSchema.parse({ focus: "12" }).focus).toBe(12)
  })
  it("falls back to undefined for zero, negative or non-numeric focus values", () => {
    expect(mapSearchSchema.parse({ focus: 0 }).focus).toBeUndefined()
    expect(mapSearchSchema.parse({ focus: -3 }).focus).toBeUndefined()
    expect(mapSearchSchema.parse({ focus: "not-a-number" }).focus).toBeUndefined()
  })
})

describe("focusIp search param", () => {
  it("keeps a non-empty IP string", () => {
    expect(mapSearchSchema.parse({ focusIp: "203.0.113.9" }).focusIp).toBe("203.0.113.9")
  })
  it("falls back to undefined for empty or non-string values", () => {
    expect(mapSearchSchema.parse({ focusIp: "" }).focusIp).toBeUndefined()
    expect(mapSearchSchema.parse({ focusIp: 42 }).focusIp).toBeUndefined()
  })
})

describe("flyToSearch", () => {
  it("targets a known location id and clears the data filters", () => {
    expect(flyToSearch("203.0.113.9", 12)).toEqual({
      focus: 12,
      focusIp: undefined,
      server: undefined,
      countries: undefined,
      cities: undefined,
    })
  })
  it("falls back to resolving the IP when no location id is known", () => {
    expect(flyToSearch("203.0.113.9")).toEqual({
      focus: undefined,
      focusIp: "203.0.113.9",
      server: undefined,
      countries: undefined,
      cities: undefined,
    })
  })
})
