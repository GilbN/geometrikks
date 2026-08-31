import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The committed artifact, not the network: CI re-asserts the generator's
// guarantees without fetching Natural Earth.
const collection = JSON.parse(
  readFileSync(new URL("../static/countries.geojson", import.meta.url), "utf8"),
)

describe("vendored countries.geojson", () => {
  it("is a FeatureCollection with features", () => {
    expect(collection.type).toBe("FeatureCollection")
    expect(collection.features.length).toBeGreaterThan(150)
  })

  it("every feature has a unique two-letter uppercase id", () => {
    const ids = collection.features.map((f: { properties: { id: string } }) => f.properties.id)
    for (const id of ids) expect(id).toMatch(/^[A-Z]{2}$/)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("carries only id and name properties", () => {
    for (const f of collection.features) {
      expect(Object.keys(f.properties).sort()).toEqual(["id", "name"])
    }
  })

  it("fixes the Natural Earth -99 casualties", () => {
    const ids = new Set(collection.features.map((f: { properties: { id: string } }) => f.properties.id))
    for (const code of ["FR", "NO", "XK"]) expect(ids.has(code)).toBe(true)
  })
})
