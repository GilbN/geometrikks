/**
 * Slim embedded map for the geo-logs page: markers + clusters (shared layer
 * specs from map/layers.ts) with the same location popup as the full map,
 * but no controls overlay or live pulses. Filtered through
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
import type { FeatureCollection, Point } from "geojson"
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl"

import { FRAME_SURFACE } from "@/components/data/frame"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { useMapStyle } from "@/components/map/hooks/useMapStyle"
import { MapAttribution } from "@/components/map/MapAttribution"
import { MapPopup, type PopupInfo } from "@/components/map/MapPopup"
import {
  clusterCountLayer,
  clusterLayer,
  unclusteredPointLabelLayer,
  unclusteredPointLayer,
} from "@/components/map/layers"
import { MAPLIBRE_WORKER_URL } from "@/lib/maplibre-worker"
import { useGeoLogsGeoJSON } from "@/lib/queries"
import { cn } from "@/lib/utils"

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
  const { mapStyle, transformRequest, ready: mapReady } = useMapStyle()
  const { data: geojson, error, isLoading, isError, refetch } = useGeoLogsGeoJSON()
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

  const onClick = useCallback((event: MapLayerMouseEvent) => {
    const feature = event.features?.[0]
    if (!feature) {
      setPopup(null)
      return
    }
    const geometry = feature.geometry as Point

    if (feature.properties?.cluster) {
      const clusterId = feature.properties.cluster_id as number
      const source = mapRef.current?.getSource("geo-data") as GeoJSONSource
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

  const state = dataState(isLoading || !mapReady, isError, geojson?.features.length ?? 0)

  // Loading, error and empty go through the panel so they match the chart
  // beside them. The ready state is the bare map: no header or body
  // padding, and it fills whatever height the grid row gives the card, so
  // the map is as big as the chart next to it.
  if (state !== "ready") {
    return (
      <SignalPanel
        title="Spatial preview"
        description="Request locations in the selected range."
        state={state}
        error={error?.message ?? "Failed to load map data."}
        onRetry={() => void refetch()}
        bodyClassName="min-h-[320px]"
      />
    )
  }

  return (
    <section aria-label="Spatial preview" className={cn(FRAME_SURFACE, "relative min-h-[320px]")}>
      <div className="absolute inset-0">
        <Map
          ref={mapRef}
          workerUrl={MAPLIBRE_WORKER_URL}
          {...viewState}
          onMove={onMove}
          onClick={onClick}
          onLoad={fitOnce}
          mapStyle={mapStyle}
          transformRequest={transformRequest}
          interactiveLayerIds={["clusters", "unclustered-point"]}
          cursor="pointer"
          attributionControl={false}
        >
          <NavigationControl position="top-right" showCompass={false} />
          <MapAttribution />
          {geojson && (
            <Source
              id="geo-data"
              type="geojson"
              data={geojson as unknown as FeatureCollection}
              cluster
              clusterMaxZoom={14}
              clusterRadius={50}
              clusterProperties={{
                // Sum event_count for all points in the cluster
                sum_event_count: ["+", ["get", "eventCount"]],
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
      </div>
    </section>
  )
}
