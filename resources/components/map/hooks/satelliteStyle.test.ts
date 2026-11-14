import type { StyleSpecification } from "maplibre-gl"
import { describe, expect, it } from "vitest"

import { buildSatelliteStyle } from "./satelliteStyle"

const cartoDark: StyleSpecification = {
  version: 8,
  glyphs: "https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf",
  sources: { protomaps: { type: "vector", url: "https://tiles.basemaps.cartocdn.com/vectortiles/carto.streets/v1/tiles.json" } },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#0e0e0e" } },
    { id: "water", type: "fill", source: "protomaps", "source-layer": "water" },
    { id: "road_pri_fill_noramp", type: "line", source: "protomaps", "source-layer": "roads" },
    { id: "boundary_county", type: "line", source: "protomaps", "source-layer": "boundaries" },
    { id: "boundary_state", type: "line", source: "protomaps", "source-layer": "boundaries", paint: { "line-width": 1 } },
    { id: "boundary_country_outline", type: "line", source: "protomaps", "source-layer": "boundaries" },
    { id: "boundary_country_inner", type: "line", source: "protomaps", "source-layer": "boundaries" },
    { id: "watername_ocean", type: "symbol", source: "protomaps", "source-layer": "water" },
    { id: "place_country_1", type: "symbol", source: "protomaps", "source-layer": "places" },
    { id: "poi_park", type: "symbol", source: "protomaps", "source-layer": "pois" },
    { id: "roadname_major", type: "symbol", source: "protomaps", "source-layer": "roads" },
  ],
}

describe("buildSatelliteStyle", () => {
  it("puts the imagery right above the background and keeps only borders and place labels", () => {
    const style = buildSatelliteStyle(cartoDark, "esri-key")

    expect(style.layers.map((layer) => layer.id)).toEqual([
      "background",
      "satellite",
      "boundary_state",
      "boundary_country_inner",
      "watername_ocean",
      "place_country_1",
    ])
  })

  it("puts the imagery at the bottom when the CARTO style has no background", () => {
    const style = buildSatelliteStyle({ ...cartoDark, layers: cartoDark.layers.slice(1) }, "k")

    expect(style.layers[0]?.id).toBe("satellite")
  })

  it("sends the key with every imagery tile and credits Esri", () => {
    const source = buildSatelliteStyle(cartoDark, "a b&c").sources.satellite

    expect(source).toMatchObject({
      type: "raster",
      tiles: ["https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=a%20b%26c"],
    })
    expect(source).toHaveProperty("attribution", expect.stringContaining("Powered by"))
  })

  it("keeps the CARTO sources and glyphs that the labels need", () => {
    const style = buildSatelliteStyle(cartoDark, "k")

    expect(style.sources.protomaps).toEqual(cartoDark.sources.protomaps)
    expect(style.glyphs).toBe(cartoDark.glyphs)
  })

  it("lightens the borders so they read on imagery", () => {
    const style = buildSatelliteStyle(cartoDark, "k")
    const border = style.layers.find((layer) => layer.id === "boundary_country_inner")

    expect(border).toHaveProperty(["paint", "line-color"], "rgba(255, 255, 255, 0.55)")
  })
})
