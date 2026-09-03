import { describe, expect, it } from "vitest"

import { createCartoRequestTransform, withCartoApiKey } from "./cartoRequestTransform"

describe("withCartoApiKey", () => {
  it("appends the key to CARTO CDN tile, style, sprite and glyph URLs", () => {
    const key = "abc123"
    expect(
      withCartoApiKey("https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/3/4/2.mvt", key),
    ).toBe("https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/3/4/2.mvt?key=abc123")
    expect(withCartoApiKey("https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json", key)).toBe(
      "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=abc123",
    )
    expect(withCartoApiKey("https://tiles.basemaps.cartocdn.com/fonts/Montserrat%20Regular/0-255.pbf", key)).toBe(
      "https://tiles.basemaps.cartocdn.com/fonts/Montserrat%20Regular/0-255.pbf?key=abc123",
    )
  })

  it("keeps existing query parameters", () => {
    expect(withCartoApiKey("https://tiles.basemaps.cartocdn.com/gl/positron-gl-style/sprite.json?v=2", "k")).toBe(
      "https://tiles.basemaps.cartocdn.com/gl/positron-gl-style/sprite.json?v=2&key=k",
    )
  })

  it("leaves non-CARTO URLs alone", () => {
    expect(withCartoApiKey("https://example.com/tiles/1/2/3.pbf", "k")).toBe("https://example.com/tiles/1/2/3.pbf")
    expect(withCartoApiKey("https://evil-cartocdn.com/x", "k")).toBe("https://evil-cartocdn.com/x")
    expect(withCartoApiKey("/static/basemap/dark.json", "k")).toBe("/static/basemap/dark.json")
  })

  it("does nothing without a key", () => {
    const url = "https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/3/4/2.mvt"
    expect(withCartoApiKey(url, undefined)).toBe(url)
    expect(withCartoApiKey(url, "")).toBe(url)
  })
})

describe("createCartoRequestTransform", () => {
  it("returns undefined without a key so MapLibre skips the hook entirely", () => {
    expect(createCartoRequestTransform(undefined)).toBeUndefined()
    expect(createCartoRequestTransform("")).toBeUndefined()
  })

  it("rewrites only CARTO requests", () => {
    const transform = createCartoRequestTransform("k")!
    expect(transform("https://tiles-b.basemaps.cartocdn.com/vectortiles/carto.streets/v1/0/0/0.mvt")).toEqual({
      url: "https://tiles-b.basemaps.cartocdn.com/vectortiles/carto.streets/v1/0/0/0.mvt?key=k",
    })
    expect(transform("https://example.com/other.json")).toBeUndefined()
  })
})
