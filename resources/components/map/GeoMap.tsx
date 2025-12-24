/**
 * Main map component with heatmap and cluster visualization layers.
 */

import { useState, useCallback, useMemo, useRef } from "react"
import Map, {
  Source,
  Layer,
  NavigationControl,
  type MapRef,
  type ViewStateChangeEvent,
} from "react-map-gl/maplibre"
import type { LayerSpecification } from "maplibre-gl"
import "maplibre-gl/dist/maplibre-gl.css"

import { useGeoJSON } from "@/lib/queries"
import { useMapStyle } from "./hooks/useMapStyle"
import { MapControls } from "./MapControls"
import { MapLegend } from "./MapLegend"
import { MapPopup, type PopupInfo } from "./MapPopup"
import { Card, CardContent } from "@/components/ui/card"
import { AlertTriangle } from "lucide-react"

export type LayerType = "heatmap" | "markers"

// Initial viewport centered on Europe
const INITIAL_VIEW_STATE = {
  longitude: 10,
  latitude: 50,
  zoom: 3,
  pitch: 0,
  bearing: 0,
}

// Heatmap layer configuration with traditional heat colors
const heatmapLayer: LayerSpecification = {
  id: "geo-heatmap",
  type: "heatmap",
  source: "geo-data",
  maxzoom: 15,
  paint: {
    // Increase weight based on event_count property - more aggressive curve
    "heatmap-weight": [
      "interpolate",
      ["exponential", 1.5],
      ["get", "event_count"],
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
const clusterLayer: LayerSpecification = {
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
const clusterCountLayer: LayerSpecification = {
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
  },
}

// Unclustered point layer - color based on event_count (green -> yellow -> red)
// More transparent fill with strong colored stroke
const unclusteredPointLayer: LayerSpecification = {
  id: "unclustered-point",
  type: "circle",
  source: "geo-data",
  filter: ["!", ["has", "point_count"]],
  paint: {
    // Size based on event_count
    "circle-radius": [
      "interpolate",
      ["linear"],
      ["get", "event_count"],
      1, 6,
      10, 8,
      100, 12,
      1000, 16,
    ],
    // Color scale with transparency: green (low) -> yellow (medium) -> red (high)
    "circle-color": [
      "interpolate",
      ["linear"],
      ["get", "event_count"],
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
      ["get", "event_count"],
      1, "rgba(34, 197, 94, 0.9)",       // Green (low)
      10, "rgba(132, 204, 22, 0.9)",     // Lime
      50, "rgba(234, 179, 8, 0.9)",      // Yellow
      100, "rgba(249, 115, 22, 0.9)",    // Orange
      500, "rgba(239, 68, 68, 0.95)",    // Red (high)
      1000, "rgba(185, 28, 28, 1)",      // Dark red (very high)
    ],
  },
}

// Unclustered point label - shows event_count with K/M abbreviation
const unclusteredPointLabelLayer: LayerSpecification = {
  id: "unclustered-point-label",
  type: "symbol",
  source: "geo-data",
  filter: ["!", ["has", "point_count"]],
  layout: {
    "text-field": [
      "case",
      [">=", ["get", "event_count"], 1000000],
      ["concat", ["to-string", ["floor", ["/", ["get", "event_count"], 1000000]]], "M+"],
      [">=", ["get", "event_count"], 1000],
      ["concat", ["to-string", ["floor", ["/", ["get", "event_count"], 1000]]], "K+"],
      ["to-string", ["get", "event_count"]]
    ],
    "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
    "text-size": 10,
  },
  paint: {
    "text-color": "#ffffff",
    // "text-halo-color": "#000000",
    "text-halo-width": 1,
  },
}

export default function GeoMap() {
  const mapRef = useRef<MapRef>(null)
  const { mapStyle } = useMapStyle()
  const { data: geojson, isLoading, isError, error } = useGeoJSON()

  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE)
  const [activeLayer, setActiveLayer] = useState<LayerType>("markers")
  const [popup, setPopup] = useState<PopupInfo | null>(null)

  // Handle view state changes
  const onMove = useCallback((evt: ViewStateChangeEvent) => {
    setViewState(evt.viewState)
  }, [])

  // Fit map to data bounds
  const fitToBounds = useCallback(() => {
    if (!geojson?.features.length || !mapRef.current) return

    const coordinates = geojson.features.map(
      (f) => f.geometry.coordinates as [number, number]
    )

    if (coordinates.length === 0) return

    // Calculate bounding box
    const lngs = coordinates.map((c) => c[0])
    const lats = coordinates.map((c) => c[1])

    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ]

    mapRef.current.fitBounds(bounds, {
      padding: 50,
      maxZoom: 12,
      duration: 1000,
    })
  }, [geojson])

  // Handle map click for markers layer
  const onClick = useCallback(
    (event: maplibregl.MapLayerMouseEvent) => {
      if (activeLayer !== "markers") return

      const features = event.features
      if (!features?.length) {
        setPopup(null)
        return
      }

      const feature = features[0]
      const geometry = feature.geometry as GeoJSON.Point

      // Handle cluster click - zoom in
      if (feature.properties?.cluster) {
        const clusterId = feature.properties.cluster_id as number
        const source = mapRef.current?.getSource("geo-data") as maplibregl.GeoJSONSource
        if (source) {
          source.getClusterExpansionZoom(clusterId).then((zoom) => {
            mapRef.current?.easeTo({
              center: geometry.coordinates as [number, number],
              zoom: zoom,
              duration: 500,
            })
          }).catch(() => {
            // Ignore cluster zoom errors
          })
        }
        return
      }

      // Show popup for unclustered point
      setPopup({
        longitude: geometry.coordinates[0],
        latitude: geometry.coordinates[1],
        properties: feature.properties as PopupInfo["properties"],
      })
    },
    [activeLayer]
  )

  // Compute max event count for legend
  const maxEventCount = useMemo(() => {
    if (!geojson?.features.length) return 0
    return Math.max(...geojson.features.map((f) => f.properties.event_count))
  }, [geojson])

  // Show error state
  if (isError) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-background">
        <Card className="max-w-md border-destructive/50 bg-destructive/10">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-destructive">
                  Failed to load map data
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {error?.message ?? "Unknown error occurred"}
                </p>
                <p className="text-xs text-muted-foreground mt-2">
                  Make sure the backend server is running.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="h-full w-full relative">
      <Map
        ref={mapRef}
        {...viewState}
        onMove={onMove}
        onClick={onClick}
        mapStyle={mapStyle}
        interactiveLayerIds={
          activeLayer === "markers"
            ? ["clusters", "unclustered-point"]
            : undefined
        }
        cursor={activeLayer === "markers" ? "pointer" : "grab"}
        attributionControl={false}
      >
        {/* Navigation controls */}
        <NavigationControl position="bottom-right" showCompass={false} />

        {/* GeoJSON data source */}
        {geojson && (
          <Source
            id="geo-data"
            type="geojson"
            data={geojson}
            cluster={activeLayer === "markers"}
            clusterMaxZoom={14}
            clusterRadius={50}
            clusterProperties={{
              // Sum event_count for all points in the cluster
              sum_event_count: ["+", ["get", "event_count"]],
            }}
          >
            {/* Heatmap layer */}
            {activeLayer === "heatmap" && (
              <Layer {...heatmapLayer} />
            )}

            {/* Cluster/Marker layers */}
            {activeLayer === "markers" && (
              <>
                <Layer {...clusterLayer} />
                <Layer {...clusterCountLayer} />
                <Layer {...unclusteredPointLayer} />
                <Layer {...unclusteredPointLabelLayer} />
              </>
            )}
          </Source>
        )}

        {/* Popup */}
        {popup && activeLayer === "markers" && (
          <MapPopup
            longitude={popup.longitude}
            latitude={popup.latitude}
            properties={popup.properties}
            onClose={() => setPopup(null)}
          />
        )}
      </Map>

      {/* Controls overlay */}
      <MapControls
        activeLayer={activeLayer}
        onLayerChange={setActiveLayer}
        onFitBounds={fitToBounds}
        isLoading={isLoading}
        featureCount={geojson?.features.length ?? 0}
      />

      {/* Legend - show for both modes */}
      <MapLegend maxValue={maxEventCount} layerType={activeLayer} />
    </div>
  )
}
