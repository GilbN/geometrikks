/**
 * Main map component with heatmap and cluster visualization layers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Map, {
  Source,
  Layer,
  NavigationControl,
  type MapRef,
  type ViewStateChangeEvent,
} from "react-map-gl/maplibre"
import "maplibre-gl/dist/maplibre-gl.css"

import {
  useGeoJSON,
  useGlobalTopIPs,
  useRuntimeSettings,
  useBannedLocations,
  useCrowdsecStatus,
} from "@/lib/queries"
import { useMapStyle } from "./hooks/useMapStyle"
import {
  bannedPointLayer,
  clusterCountLayer,
  clusterLayer,
  heatmapLayer,
  unclusteredPointLabelLayer,
  unclusteredPointLayer,
} from "./layers"
import { MapControls } from "./MapControls"
import { LivePulses } from "./LivePulses"
import { HomeMarker } from "./HomeMarker"
import { MapLegend } from "./MapLegend"
import { MapPopup, type PopupInfo } from "./MapPopup"
import { LiveRequestPopup } from "./LiveRequestPopup"
import { LiveVitals } from "./LiveVitals"
import { LiveStrips } from "./LiveStrips"
import { Card, CardContent } from "@/components/ui/card"
import { AlertTriangle } from "lucide-react"
import { getDemoTrafficMode } from "@/lib/demo-traffic"
import { LiveTrafficProvider, useLiveTrafficStore } from "@/lib/live-traffic/context"
import type { LiveRequest } from "@/lib/live-traffic/types"
import { useIsMobile } from "@/hooks/use-mobile"

export type LayerType = "heatmap" | "markers"
export type MapProjection = "mercator" | "globe"

// Initial viewport centered on Europe
const INITIAL_VIEW_STATE = {
  longitude: 10,
  latitude: 50,
  zoom: 3,
  pitch: 0,
  bearing: 0,
}

const ROUTE_EFFECTS_STORAGE_KEY = "geometrikks-route-effects-enabled"
const MAP_PROJECTION_STORAGE_KEY = "geometrikks-map-projection"
const HOME_MARKER_STORAGE_KEY = "geometrikks-home-marker-enabled"

function loadRouteEffectsPreference(): boolean {
  try {
    return localStorage.getItem(ROUTE_EFFECTS_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

function loadHomeMarkerPreference(): boolean {
  try {
    return localStorage.getItem(HOME_MARKER_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

function loadMapProjectionPreference(): MapProjection {
  try {
    return localStorage.getItem(MAP_PROJECTION_STORAGE_KEY) === "globe"
      ? "globe"
      : "mercator"
  } catch {
    return "mercator"
  }
}

function GeoMapInner({
  liveMode,
  onLiveModeChange,
}: {
  liveMode: boolean
  onLiveModeChange: (enabled: boolean) => void
}) {
  const demoTrafficMode = getDemoTrafficMode()
  const mapRef = useRef<MapRef>(null)
  const { mapStyle } = useMapStyle()
  const isMobile = useIsMobile()
  const [selectedCountries, setSelectedCountries] = useState<string[]>([])
  const [selectedCities, setSelectedCities] = useState<string[]>([])
  const { data: geojson, isLoading: isLoadingGeoJSON, isError, error } = useGeoJSON({
    countryCodes: selectedCountries,
    cities: selectedCities,
  })
  const { data: globalTopIPs, isLoading: isLoadingTopIPs } = useGlobalTopIPs()
  const { data: runtimeSettings } = useRuntimeSettings()
  const homeDestination = useMemo<[number, number] | null>(() => {
    const latitude = runtimeSettings?.map.home_latitude
    const longitude = runtimeSettings?.map.home_longitude
    return typeof latitude === "number" && typeof longitude === "number"
      ? [longitude, latitude]
      : null
  }, [runtimeSettings])

  const isLoading = isLoadingGeoJSON || isLoadingTopIPs

  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE)
  const [activeLayer, setActiveLayer] = useState<LayerType>("markers")
  const [projection, setProjection] = useState<MapProjection>(loadMapProjectionPreference)
  const [routeEffectsEnabled, setRouteEffectsEnabled] = useState(loadRouteEffectsPreference)
  const [homeMarkerEnabled, setHomeMarkerEnabled] = useState(loadHomeMarkerPreference)
  const [showBanned, setShowBanned] = useState(false)
  const [popup, setPopup] = useState<PopupInfo | null>(null)
  const liveStore = useLiveTrafficStore()
  const [livePopup, setLivePopup] = useState<LiveRequest | null>(null)

  // Banned-IP overlay: attackers with an active CrowdSec decision that also
  // appear in this server's own traffic.
  const { data: crowdsecStatus } = useCrowdsecStatus()
  const { data: bannedLocations, isFetching: isFetchingBanned } =
    useBannedLocations(showBanned)
  const bannedGeoJSON = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: (bannedLocations ?? []).map((loc) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [loc.longitude, loc.latitude] },
        properties: {
          ip: loc.ip,
          city: loc.city,
          country_code: loc.country_code,
        },
      })),
    }),
    [bannedLocations],
  )
  const mercatorZoomRef = useRef(INITIAL_VIEW_STATE.zoom)

  useEffect(() => {
    try {
      localStorage.setItem(ROUTE_EFFECTS_STORAGE_KEY, String(routeEffectsEnabled))
    } catch {
      // Storage may be blocked; keep the in-memory preference for this session.
    }
  }, [routeEffectsEnabled])

  useEffect(() => {
    try {
      localStorage.setItem(HOME_MARKER_STORAGE_KEY, String(homeMarkerEnabled))
    } catch {
      // Storage may be blocked; keep the in-memory preference for this session.
    }
  }, [homeMarkerEnabled])

  useEffect(() => {
    try {
      localStorage.setItem(MAP_PROJECTION_STORAGE_KEY, projection)
    } catch {
      // Storage may be blocked; keep the in-memory preference for this session.
    }
  }, [projection])

  // Filter options come from the last UNFILTERED result (a second query just
  // for options would be wasteful), held in a ref so the option lists don't
  // shrink to the filtered subset while a filter is active.
  const optionsRef = useRef<{
    countries: string[]
    cities: string[]
    countryLabels: Record<string, string>
  }>({
    countries: [],
    cities: [],
    countryLabels: {},
  })
  const filterOptions = useMemo(() => {
    if (geojson && selectedCountries.length === 0 && selectedCities.length === 0) {
      const countryLabels: Record<string, string> = {}
      const cities = new Set<string>()
      for (const f of geojson.features) {
        const code = f.properties.country_code
        if (code) {
          // Display "<name> (<code>)" but keep the code as the option value,
          // since the value feeds useGeoJSON({ countryCodes }).
          countryLabels[code] = f.properties.country_name
            ? `${f.properties.country_name} (${code})`
            : code
        }
        if (f.properties.city) cities.add(f.properties.city)
      }
      optionsRef.current = {
        // Sort country codes by their display label.
        countries: Object.keys(countryLabels).sort((a, b) =>
          countryLabels[a].localeCompare(countryLabels[b]),
        ),
        cities: [...cities].sort(),
        countryLabels,
      }
    }
    return optionsRef.current
  }, [geojson, selectedCountries, selectedCities])

  // Handle view state changes
  const onMove = useCallback((evt: ViewStateChangeEvent) => {
    setViewState(evt.viewState)
  }, [])

  // Fit map to data bounds
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

    const bounds: [[number, number], [number, number]] = [
      [minLng, minLat],
      [maxLng, maxLat],
    ]

    mapRef.current.fitBounds(bounds, {
      padding: 50,
      maxZoom: 12,
      duration: 1000,
    })
  }, [geojson])

  // Fly to a specific location (for top IPs click)
  const flyToLocation = useCallback((lat: number, lng: number) => {
    mapRef.current?.flyTo({
      center: [lng, lat],
      zoom: 7,
      duration: 1500,
    })
  }, [])

  // Fly to the configured server home location
  const goToHome = useCallback(() => {
    if (!homeDestination) return
    mapRef.current?.flyTo({
      center: homeDestination,
      zoom: 7,
      duration: 1500,
    })
  }, [homeDestination])

  const changeProjection = useCallback((nextProjection: MapProjection) => {
    if (nextProjection === projection) return

    if (nextProjection === "globe") {
      mercatorZoomRef.current = viewState.zoom
      setProjection("globe")
      mapRef.current?.easeTo({
        zoom: Math.min(viewState.zoom, 2.2),
        pitch: 0,
        duration: 900,
      })
      return
    }

    setProjection("mercator")
    mapRef.current?.easeTo({
      zoom: mercatorZoomRef.current,
      pitch: 0,
      duration: 900,
    })
  }, [projection, viewState.zoom])

  // Handle map click: live packets first, then the markers layer
  const onClick = useCallback(
    (event: maplibregl.MapLayerMouseEvent) => {
      const liveFeature = event.features?.find((feature) =>
        feature.layer.id === "live-origin-core" || feature.layer.id === "live-packet-core",
      )
      if (liveFeature) {
        const requestId = liveFeature.properties?.requestId as string | undefined
        const request = requestId ? liveStore.getRequest(requestId) : undefined
        if (request) {
          setPopup(null)
          setLivePopup(request)
        }
        return
      }

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
      setLivePopup(null)
      setPopup({
        longitude: geometry.coordinates[0],
        latitude: geometry.coordinates[1],
        properties: feature.properties as PopupInfo["properties"],
      })
    },
    [activeLayer, liveStore]
  )

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
        projection={projection}
        renderWorldCopies={projection === "mercator"}
        interactiveLayerIds={[
          ...(activeLayer === "markers" ? ["clusters", "unclustered-point"] : []),
          ...(liveMode && routeEffectsEnabled ? ["live-origin-core", "live-packet-core"] : []),
        ]}
        cursor={activeLayer === "markers" ? "pointer" : "grab"}
        attributionControl={false}
      >
        {/* Navigation controls */}
        <NavigationControl position="bottom-right" showCompass={true} />

        {/* GeoJSON data source */}
        {/* The `key` only flips when the clustering requirement changes (markers
            need clustering, heatmap does not). MapLibre reads `cluster` only at
            source creation, so a layer switch must recreate the source for the
            new clustering state to take effect - otherwise flipping back to
            markers never regroups the points. Within a single layer the key is
            stable, so data refreshes still diff via setData without remounting
            (which would tear down and re-add every layer). */}
        {geojson && (
          <Source
            key={activeLayer === "markers" ? "clustered" : "plain"}
            id="geo-data"
            type="geojson"
            data={geojson as unknown as GeoJSON.FeatureCollection}
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
            {activeLayer === "markers" && [
              <Layer key="cluster" {...clusterLayer} />,
              <Layer key="cluster-count" {...clusterCountLayer} />,
              <Layer key="unclustered-point" {...unclusteredPointLayer} />,
              <Layer key="unclustered-point-label" {...unclusteredPointLabelLayer} />,
            ]}
          </Source>
        )}

        {/* Banned-IP overlay: stacks on top of either base layer */}
        {showBanned && crowdsecStatus?.enabled && (
          <Source id="banned-data" type="geojson" data={bannedGeoJSON}>
            <Layer {...bannedPointLayer} />
          </Source>
        )}

        {/* Live requests travelling from their GeoIP origin to the configured server home. */}
        <LivePulses
          enabled={liveMode && routeEffectsEnabled}
          destination={homeDestination}
        />

        {/* Server home location beacon */}
        {homeMarkerEnabled && (
          <HomeMarker coordinates={homeDestination} onClick={goToHome} />
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

        {livePopup && livePopup.coordinates && (
          <LiveRequestPopup request={livePopup} onClose={() => setLivePopup(null)} />
        )}
      </Map>

      {liveMode && !isMobile && (
        <div className="pointer-events-none absolute left-4 top-4 z-10">
          <LiveVitals variant="desktop" />
        </div>
      )}

      {liveMode && !isMobile && (
        <div className="pointer-events-none absolute bottom-4 left-4 z-10">
          <LiveStrips onSelect={setLivePopup} />
        </div>
      )}

      {/* Controls overlay */}
      <MapControls
        activeLayer={activeLayer}
        onLayerChange={setActiveLayer}
        projection={projection}
        onProjectionChange={changeProjection}
        liveMode={liveMode}
        demoTrafficMode={demoTrafficMode}
        onLiveModeChange={onLiveModeChange}
        routeEffectsEnabled={routeEffectsEnabled}
        onRouteEffectsChange={setRouteEffectsEnabled}
        routeHomeAvailable={homeDestination !== null}
        homeMarkerEnabled={homeMarkerEnabled}
        onHomeMarkerChange={setHomeMarkerEnabled}
        bannedOverlayAvailable={crowdsecStatus?.enabled === true}
        bannedOverlayEnabled={showBanned}
        onBannedOverlayChange={setShowBanned}
        bannedCount={bannedLocations?.length ?? 0}
        bannedOverlayLoading={showBanned && isFetchingBanned}
        onFitBounds={fitToBounds}
        onGoHome={goToHome}
        isLoading={isLoading}
        featureStats={geojson?.stats ?? { events: 0, countries: 0, cities: 0, locations: 0 }}
        topIPs={globalTopIPs?.top_ips ?? []}
        onFlyToLocation={flyToLocation}
        countryOptions={filterOptions.countries}
        countryLabels={filterOptions.countryLabels}
        cityOptions={filterOptions.cities}
        selectedCountries={selectedCountries}
        selectedCities={selectedCities}
        onCountriesChange={setSelectedCountries}
        onCitiesChange={setSelectedCities}
      />

      {/* Legend - show for both modes */}
      <MapLegend maxValue={geojson?.stats.events ?? 0} layerType={activeLayer} />
    </div>
  )
}

export default function GeoMap() {
  const [liveMode, setLiveMode] = useState(getDemoTrafficMode() !== "off")

  return (
    <LiveTrafficProvider enabled={liveMode}>
      <GeoMapInner liveMode={liveMode} onLiveModeChange={setLiveMode} />
    </LiveTrafficProvider>
  )
}
