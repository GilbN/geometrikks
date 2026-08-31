/**
 * Shared MapLibre layer specifications for the geo maps (full map page and
 * the embedded geo-logs map). All layers read from the "geo-data" source.
 */

import type { LayerSpecification } from "maplibre-gl"

import type { MapRamp } from "./hooks/useMapRamp"

// Heatmap layer configuration with traditional heat colors
export const heatmapLayer: LayerSpecification = {
  id: "geo-heatmap",
  type: "heatmap",
  source: "geo-data",
  maxzoom: 15,
  paint: {
    // Increase weight based on eventCount property - more aggressive curve
    "heatmap-weight": [
      "interpolate",
      ["exponential", 1.5],
      ["get", "eventCount"],
      0, 0,
      1, 0.1,
      10, 0.4,
      100, 0.7,
      1000, 1,
    ],
    // Increase intensity as zoom level increases - much stronger at all zoom levels
    "heatmap-intensity": [
      "interpolate",
      ["linear"],
      ["zoom"],
      0, 1,
      5, 1.5,
      9, 2.5,
      15, 4,
    ],
    // Traditional heatmap colors: blue -> cyan -> green -> yellow -> orange -> red
    // More saturated colors and earlier color transitions
    "heatmap-color": [
      "interpolate",
      ["linear"],
      ["heatmap-density"],
      0, "rgba(0, 0, 0, 0)",
      0.05, "rgba(65, 105, 225, 0.5)",   // Royal blue - starts earlier
      0.15, "rgba(0, 191, 255, 0.6)",    // Deep sky blue
      0.25, "rgba(0, 255, 127, 0.7)",    // Spring green
      0.35, "rgba(127, 255, 0, 0.75)",   // Chartreuse
      0.45, "rgba(255, 255, 0, 0.8)",    // Yellow
      0.55, "rgba(255, 200, 0, 0.85)",   // Gold
      0.65, "rgba(255, 140, 0, 0.9)",    // Dark orange
      0.8, "rgba(255, 69, 0, 0.95)",     // Orange red
      1.0, "rgba(220, 20, 60, 1)",       // Crimson
    ],
    // Radius configuration - much larger radius for better visibility
    "heatmap-radius": [
      "interpolate",
      ["exponential", 1.75],
      ["zoom"],
      0, 12,
      3, 20,
      5, 30,
      8, 40,
      10, 50,
      12, 60,
      15, 80,
    ],
    // Opacity - keep high visibility, gentle fade at very high zoom
    "heatmap-opacity": [
      "interpolate",
      ["linear"],
      ["zoom"],
      0, 0.9,
      7, 1,
      13, 0.8,
      15, 0.6,
    ],
  },
}

// Cluster circle layer - color based on sum of event_count (green -> yellow -> red)
export const clusterLayer: LayerSpecification = {
  id: "clusters",
  type: "circle",
  source: "geo-data",
  filter: ["has", "point_count"],
  paint: {
    // Size based on point count
    "circle-radius": [
      "step",
      ["get", "point_count"],
      15,
      10, 18,
      50, 22,
      100, 26,
      500, 32,
    ],
    // Color scale based on sum of event_count: green (low) -> yellow (medium) -> red (high)
    "circle-color": [
      "interpolate",
      ["linear"],
      ["get", "sum_event_count"],
      1, "rgba(34, 197, 94, 0.4)",       // Green (low)
      50, "rgba(132, 204, 22, 0.4)",     // Lime
      200, "rgba(234, 179, 8, 0.45)",    // Yellow
      500, "rgba(249, 115, 22, 0.45)",   // Orange
      1000, "rgba(239, 68, 68, 0.5)",    // Red (high)
      5000, "rgba(185, 28, 28, 0.55)",   // Dark red (very high)
    ],
    "circle-stroke-width": 3,
    // Stroke color matches fill but more opaque
    "circle-stroke-color": [
      "interpolate",
      ["linear"],
      ["get", "sum_event_count"],
      1, "rgba(34, 197, 94, 0.9)",       // Green (low)
      50, "rgba(132, 204, 22, 0.9)",     // Lime
      200, "rgba(234, 179, 8, 0.9)",     // Yellow
      500, "rgba(249, 115, 22, 0.9)",    // Orange
      1000, "rgba(239, 68, 68, 0.95)",   // Red (high)
      5000, "rgba(185, 28, 28, 1)",      // Dark red (very high)
    ],
  },
}

// Cluster count label - shows sum of event_count with K/M abbreviation
export const clusterCountLayer: LayerSpecification = {
  id: "cluster-count",
  type: "symbol",
  source: "geo-data",
  filter: ["has", "point_count"],
  layout: {
    "text-field": [
      "case",
      [">=", ["get", "sum_event_count"], 1000000],
      ["concat", ["to-string", ["floor", ["/", ["get", "sum_event_count"], 1000000]]], "M+"],
      [">=", ["get", "sum_event_count"], 1000],
      ["concat", ["to-string", ["floor", ["/", ["get", "sum_event_count"], 1000]]], "K+"],
      ["to-string", ["get", "sum_event_count"]]
    ],
    "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
    "text-size": 12,
  },
  paint: {
    "text-color": "#ffffff",
    "text-halo-color": "rgba(0, 0, 0, 0.25)",
    "text-halo-width": 1,
  },
}

// Unclustered point layer - color based on eventCount (green -> yellow -> red)
// More transparent fill with strong colored stroke
export const unclusteredPointLayer: LayerSpecification = {
  id: "unclustered-point",
  type: "circle",
  source: "geo-data",
  filter: ["!", ["has", "point_count"]],
  paint: {
    // Size based on eventCount
    "circle-radius": [
      "interpolate",
      ["linear"],
      ["get", "eventCount"],
      1, 6,
      10, 8,
      100, 12,
      1000, 16,
    ],
    // Color scale with transparency: green (low) -> yellow (medium) -> red (high)
    "circle-color": [
      "interpolate",
      ["linear"],
      ["get", "eventCount"],
      1, "rgba(34, 197, 94, 0.35)",      // Green (low)
      10, "rgba(132, 204, 22, 0.35)",    // Lime
      50, "rgba(234, 179, 8, 0.4)",      // Yellow
      100, "rgba(249, 115, 22, 0.4)",    // Orange
      500, "rgba(239, 68, 68, 0.45)",    // Red (high)
      1000, "rgba(185, 28, 28, 0.5)",    // Dark red (very high)
    ],
    "circle-stroke-width": 3,
    // Strong colored stroke matching the scale
    "circle-stroke-color": [
      "interpolate",
      ["linear"],
      ["get", "eventCount"],
      1, "rgba(34, 197, 94, 0.9)",       // Green (low)
      10, "rgba(132, 204, 22, 0.9)",     // Lime
      50, "rgba(234, 179, 8, 0.9)",      // Yellow
      100, "rgba(249, 115, 22, 0.9)",    // Orange
      500, "rgba(239, 68, 68, 0.95)",    // Red (high)
      1000, "rgba(185, 28, 28, 1)",      // Dark red (very high)
    ],
  },
}

// Unclustered point label - shows eventCount with K/M abbreviation
export const unclusteredPointLabelLayer: LayerSpecification = {
  id: "unclustered-point-label",
  type: "symbol",
  source: "geo-data",
  filter: ["!", ["has", "point_count"]],
  layout: {
    "text-field": [
      "case",
      [">=", ["get", "eventCount"], 1000000],
      ["concat", ["to-string", ["floor", ["/", ["get", "eventCount"], 1000000]]], "M+"],
      [">=", ["get", "eventCount"], 1000],
      ["concat", ["to-string", ["floor", ["/", ["get", "eventCount"], 1000]]], "K+"],
      ["to-string", ["get", "eventCount"]]
    ],
    "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
    "text-size": 10,
  },
  paint: {
    "text-color": "#ffffff",
    "text-halo-color": "rgba(0, 0, 0, 0.25)",
    "text-halo-width": 1,
  },
}

// Banned-IP overlay: red markers for actively banned IPs seen in this
// server's own traffic. Reads from the separate "banned-data" source so it
// stacks on top of either the heatmap or the marker layers.
export const bannedPointLayer: LayerSpecification = {
  id: "banned-points",
  type: "circle",
  source: "banned-data",
  paint: {
    "circle-color": "#ef4444",
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 3, 6, 5, 10, 8, 14, 11],
    "circle-opacity": 0.85,
    "circle-stroke-width": 1.5,
    "circle-stroke-color": "rgba(255, 255, 255, 0.75)",
  },
}

// Country choropleth: fill color comes from a per-feature "value" state set
// by applyCountryValues(); "hover" state brightens the country under the
// cursor. Both layers read from the "countries" source (countries.geojson).
export function countryFillLayer(fillColor: unknown): LayerSpecification {
  return {
    id: "country-fill",
    type: "fill",
    source: "countries",
    paint: {
      "fill-color": fillColor as never,
      "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.95, 0.75],
    },
  } as LayerSpecification
}

export function countryBorderLayer(ramp: MapRamp): LayerSpecification {
  return {
    id: "country-border",
    type: "line",
    source: "countries",
    paint: { "line-color": ramp.border, "line-width": 0.5 },
  } as LayerSpecification
}
