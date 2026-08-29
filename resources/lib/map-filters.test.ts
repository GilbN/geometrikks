import { describe, expect, it } from "vitest"
import { decodeMapSearch, encodeMapSearch, mapSearchSchema } from "@/lib/map-filters"

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
