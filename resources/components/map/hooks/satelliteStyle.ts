/**
 * The Satellite view draws Esri World Imagery under the borders and place
 * names of CARTO Dark Matter. It leaves out CARTO's land, water, roads and
 * buildings so the imagery shows through.
 */

import type { LayerSpecification, StyleSpecification } from "maplibre-gl"

export const CARTO_DARK_STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"

const ESRI_IMAGERY_TILES =
  "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"

// Esri's terms want "Powered by Esri" beside the service's own credit line.
// MapLibre gets neither from a raw tile source, so both live in this string.
// MapAttribution folds the esri-credit span on phones.
const ESRI_ATTRIBUTION =
  '<span class="esri-credit">Powered by <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> | Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community</span>'

const SATELLITE_SOURCE_ID = "satellite"

const KEPT_BORDER_LAYERS = new Set(["boundary_country_inner", "boundary_state"])
const KEPT_LABEL_SOURCE_LAYERS = new Set(["places", "water"])

function keepsLayer(layer: LayerSpecification): boolean {
  if (KEPT_BORDER_LAYERS.has(layer.id)) return true
  return layer.type === "symbol" && KEPT_LABEL_SOURCE_LAYERS.has(layer["source-layer"] ?? "")
}

function restyleForImagery(layer: LayerSpecification): LayerSpecification {
  if (layer.id === "boundary_country_inner" && layer.type === "line") {
    return {
      ...layer,
      paint: {
        "line-color": "rgba(255, 255, 255, 0.55)",
        "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 6, 1.4],
      },
    }
  }
  if (layer.id === "boundary_state" && layer.type === "line") {
    return { ...layer, paint: { ...layer.paint, "line-color": "rgba(255, 255, 255, 0.25)" } }
  }
  if (layer.type === "symbol") {
    return {
      ...layer,
      paint: { ...layer.paint, "text-halo-color": "rgba(0, 0, 0, 0.85)", "text-halo-width": 1.4 },
    }
  }
  return layer
}

export function buildSatelliteStyle(cartoDark: StyleSpecification, esriApiKey: string): StyleSpecification {
  const imagery: LayerSpecification = { id: SATELLITE_SOURCE_ID, type: "raster", source: SATELLITE_SOURCE_ID }
  const layers: LayerSpecification[] = []
  for (const layer of cartoDark.layers) {
    if (layer.type === "background") {
      layers.push(layer, imagery)
    } else if (keepsLayer(layer)) {
      layers.push(restyleForImagery(layer))
    }
  }
  if (!layers.includes(imagery)) layers.unshift(imagery)
  return {
    ...cartoDark,
    sources: {
      ...cartoDark.sources,
      [SATELLITE_SOURCE_ID]: {
        type: "raster",
        tiles: [`${ESRI_IMAGERY_TILES}?token=${encodeURIComponent(esriApiKey)}`],
        tileSize: 256,
        maxzoom: 19,
        attribution: ESRI_ATTRIBUTION,
      },
    },
    layers,
  }
}
