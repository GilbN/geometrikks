/**
 * Slim embedded map for the geo-logs page: markers + clusters (shared layer
 * specs from map/layers.ts) with the same location popup as the full map,
 * but no controls overlay, live pulses, or legend. Filtered through
 * GeoLogFiltersContext like the rest of the page.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import Map, {
  Layer,
  NavigationControl,
  Source,
  type MapRef,
  type ViewStateChangeEvent,
} from "react-map-gl/maplibre"
import "maplibre-gl/dist/maplibre-gl.css"

import { AlertTriangle } from "lucide-react"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { MapSkeleton } from "@/components/map/MapSkeleton"
import { useMapStyle } from "@/components/map/hooks/useMapStyle"
import { MapPopup, type PopupInfo } from "@/components/map/MapPopup"
import {
  clusterCountLayer,
  clusterLayer,
  unclusteredPointLabelLayer,
  unclusteredPointLayer,
} from "@/components/map/layers"
import { useGeoLogsGeoJSON } from "@/lib/queries"

// Same starting viewport as the full map page (centered on Europe).
const INITIAL_VIEW_STATE = {
  longitude: 10,
  latitude: 50,
  zoom: 2,
  pitch: 0,
  bearing: 0,
}

export default function GeoLogsMap() {
  const mapRef = useRef<MapRef>(null)
  const { mapStyle } = useMapStyle()
  const { data: geojson, isLoading, isError } = useGeoLogsGeoJSON()
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE)
  const [popup, setPopup] = useState<PopupInfo | null>(null)
  const didFitRef = useRef(false)

  const onMove = useCallback((evt: ViewStateChangeEvent) => {
    setViewState(evt.viewState)
  }, [])

  const fitToBounds = useCallback(() => {
    if (!geojson?.features.length || !mapRef.current) return

    // Single pass: spreading thousands of coordinates into Math.min/max
    // can blow the call stack.
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
    for (const f of geojson.features) {
      const [lng, lat] = f.geometry.coordinates as [number, number]
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }

    mapRef.current.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 40, maxZoom: 10, duration: 800 },
    )
  }, [geojson])

  // Frame the data once, when the first non-empty result arrives; later
  // filter changes refresh the data in place without yanking the viewport.
  // Runs both on data arrival and on map load, whichever happens last.
  const fitOnce = useCallback(() => {
    if (didFitRef.current || !geojson?.features.length || !mapRef.current) return
    didFitRef.current = true
    fitToBounds()
  }, [geojson, fitToBounds])

  useEffect(() => {
    fitOnce()
  }, [fitOnce])

  const onClick = useCallback((event: maplibregl.MapLayerMouseEvent) => {
    const feature = event.features?.[0]
    if (!feature) {
      setPopup(null)
      return
    }
    const geometry = feature.geometry as GeoJSON.Point

    if (feature.properties?.cluster) {
      const clusterId = feature.properties.cluster_id as number
      const source = mapRef.current?.getSource("geo-data") as maplibregl.GeoJSONSource
      source?.getClusterExpansionZoom(clusterId).then((zoom) => {
        mapRef.current?.easeTo({
          center: geometry.coordinates as [number, number],
          zoom,
          duration: 500,
        })
      }).catch(() => {
        // Ignore cluster zoom errors
      })
      return
    }

    setPopup({
      longitude: geometry.coordinates[0],
      latitude: geometry.coordinates[1],
      properties: feature.properties as PopupInfo["properties"],
    })
  }, [])

  return (
    <Card className="h-[380px] gap-0 overflow-hidden py-0">
      <CardHeader className="border-b py-3">
        <CardTitle className="text-sm font-medium">Event Locations</CardTitle>
      </CardHeader>
      <div className="relative flex-1">
        {isLoading && <MapSkeleton />}
        {isError && (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" /> Failed to load map data.
          </div>
        )}
        {!isLoading && !isError && (
          <Map
            ref={mapRef}
            {...viewState}
            onMove={onMove}
            onClick={onClick}
            onLoad={fitOnce}
            mapStyle={mapStyle}
            interactiveLayerIds={["clusters", "unclustered-point"]}
            cursor="pointer"
            attributionControl={false}
          >
            <NavigationControl position="top-right" showCompass={false} />
            {geojson && (
              <Source
                id="geo-data"
                type="geojson"
                data={geojson as unknown as GeoJSON.FeatureCollection}
                cluster
                clusterMaxZoom={14}
                clusterRadius={50}
                clusterProperties={{
                  // Sum event_count for all points in the cluster
                  sum_event_count: ["+", ["get", "event_count"]],
                }}
              >
                <Layer {...clusterLayer} />
                <Layer {...clusterCountLayer} />
                <Layer {...unclusteredPointLayer} />
                <Layer {...unclusteredPointLabelLayer} />
              </Source>
            )}
            {popup && (
              <MapPopup
                longitude={popup.longitude}
                latitude={popup.latitude}
                properties={popup.properties}
                onClose={() => setPopup(null)}
              />
            )}
          </Map>
        )}
      </div>
    </Card>
  )
}
