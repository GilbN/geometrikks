/**
 * Main map component with heatmap and cluster visualization layers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import Map, {
  Source,
  Layer,
  NavigationControl,
  type MapRef,
  type ViewStateChangeEvent,
} from "react-map-gl/maplibre"
import "maplibre-gl/dist/maplibre-gl.css"
import type { FeatureCollection, Point } from "geojson"
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl"

import {
  useGeoJSON,
  useGlobalTopIPs,
  useRuntimeSettings,
  useBannedLocations,
  useCrowdsecStatus,
  useGeoEventFacets,
  useSiteHomes,
} from "@/lib/queries"
import { buildHomeResolver, homeBeacons, type Coordinate, type SiteHomesData } from "@/lib/site-homes"
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
import { MapPopup, type PopupInfo } from "./MapPopup"
import { LiveRequestCard, LiveRequestPopup } from "./LiveRequestPopup"
import { LiveVitalsPill } from "./LiveVitalsPill"
import { LiveRail } from "./LiveRail"
import { LiveFeedSheet } from "./LiveFeedSheet"
import { Card, CardContent } from "@/components/ui/card"
import { AlertTriangle } from "lucide-react"
import { getDemoTrafficMode } from "@/lib/demo-traffic"
import { decodeMapSearch, encodeMapSearch } from "@/lib/map-filters"
import { useUrlFilters } from "@/hooks/use-url-filters"
import { loadLiveOverlays, saveLiveOverlays, type LiveOverlayPreferences } from "@/lib/live-overlays"
import {
  loadLayerPreference,
  loadLivePreference,
  saveLayerPreference,
  saveLivePreference,
} from "@/lib/map-preferences"
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
  const search = useSearch({ from: "/map" })
  const navigate = useNavigate({ from: "/map" })
  const { filters, setFilters } = useUrlFilters({
    search,
    navigate,
    decode: decodeMapSearch,
    encode: encodeMapSearch,
  })
  const selectedSources = filters.sources
  const selectedCountries = filters.countryCodes
  const selectedCities = filters.cities
  const onSourcesChange = useCallback(
    (values: string[]) => setFilters((prev) => ({ ...prev, sources: values })),
    [setFilters],
  )
  const onCountriesChange = useCallback(
    (values: string[]) => setFilters((prev) => ({ ...prev, countryCodes: values })),
    [setFilters],
  )
  const onCitiesChange = useCallback(
    (values: string[]) => setFilters((prev) => ({ ...prev, cities: values })),
    [setFilters],
  )
  const { data: geojson, isLoading: isLoadingGeoJSON, isError, error } = useGeoJSON({
    countryCodes: selectedCountries,
    cities: selectedCities,
    hostnames: selectedSources,
  })
  const { data: facets, isLoading: facetsLoading } = useGeoEventFacets()
  const sourceOptions = facets?.hostnames ?? []
  const { data: globalTopIPs, isLoading: isLoadingTopIPs } = useGlobalTopIPs()
  const { data: runtimeSettings } = useRuntimeSettings()
  const homeDestination = useMemo<Coordinate | null>(() => {
    const latitude = runtimeSettings?.map.homeLatitude
    const longitude = runtimeSettings?.map.homeLongitude
    return typeof latitude === "number" && typeof longitude === "number"
      ? [longitude, latitude]
      : null
  }, [runtimeSettings])
  const { data: siteHomes } = useSiteHomes()
  // Falls back to the single-home runtime setting while site-homes is
  // unavailable (DB-degraded 500, or just the first fetch in flight) so
  // beacons don't go empty and flash in once the query resolves.
  const siteHomesData = useMemo<SiteHomesData | undefined>(
    () =>
      siteHomes ??
      (homeDestination
        ? { homes: [], default: { latitude: homeDestination[1], longitude: homeDestination[0] } }
        : undefined),
    [siteHomes, homeDestination],
  )
  const resolveDestination = useMemo(() => buildHomeResolver(siteHomesData), [siteHomesData])
  const beacons = useMemo(() => homeBeacons(siteHomesData), [siteHomesData])

  const isLoading = isLoadingGeoJSON || isLoadingTopIPs

  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE)
  const [activeLayer, setActiveLayer] = useState<LayerType>(loadLayerPreference)
  const [projection, setProjection] = useState<MapProjection>(loadMapProjectionPreference)
  const [routeEffectsEnabled, setRouteEffectsEnabled] = useState(loadRouteEffectsPreference)
  const [homeMarkerEnabled, setHomeMarkerEnabled] = useState(loadHomeMarkerPreference)
  const [liveOverlays, setLiveOverlays] = useState<LiveOverlayPreferences>(loadLiveOverlays)
  const [showBanned, setShowBanned] = useState(false)
  const [popup, setPopup] = useState<PopupInfo | null>(null)
  const liveStore = useLiveTrafficStore()
  const [livePopup, setLivePopup] = useState<LiveRequest | null>(null)
  const [feedOpen, setFeedOpen] = useState(false)

  // Banned-IP overlay: attackers with an active CrowdSec decision that also
  // appear in this server's own traffic.
  const { data: crowdsecStatus } = useCrowdsecStatus()
  const { data: bannedLocations, isFetching: isFetchingBanned } =
    useBannedLocations(showBanned)
  const bannedGeoJSON = useMemo<FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: (bannedLocations ?? []).map((loc) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [loc.longitude, loc.latitude] },
        properties: {
          ip: loc.ip,
          city: loc.city,
          countryCode: loc.countryCode,
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

  useEffect(() => {
    saveLiveOverlays(liveOverlays)
  }, [liveOverlays])

  useEffect(() => {
    saveLayerPreference(activeLayer)
  }, [activeLayer])

  // Live off tears down the store; any live-only UI referencing it must go
  // too, or a popup stays pinned to the map after the request it describes
  // is gone.
  useEffect(() => {
    if (!liveMode) {
      setLivePopup(null)
      setFeedOpen(false)
    }
  }, [liveMode])

  // Filter options come from the last UNFILTERED result (a second query just
  // for options would be wasteful), held in a ref so the option lists don't
  // shrink to the filtered subset while a filter is active.
  // Options come from the facets endpoint, not the geojson payload: with
  // URL-restored filters the first geojson response is already filtered, so
  // deriving options from it would leave the comboboxes empty after reload.
  const filterOptions = useMemo(() => {
    const countryLabels: Record<string, string> = {}
    for (const c of facets?.countries ?? []) {
      // Display "<name> (<code>)" but keep the code as the option value,
      // since the value feeds useGeoJSON({ countryCodes }).
      countryLabels[c.code] = c.name ? `${c.name} (${c.code})` : c.code
    }
    return {
      // Sort country codes by their display label.
      countries: Object.keys(countryLabels).sort((a, b) =>
        countryLabels[a].localeCompare(countryLabels[b]),
      ),
      cities: [...(facets?.cities ?? [])].sort(),
      countryLabels,
    }
  }, [facets])

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

  const flyToCoordinate = useCallback((coordinates: Coordinate) => {
    mapRef.current?.flyTo({
      center: coordinates,
      zoom: 7,
      duration: 1500,
    })
  }, [])

  // With exactly one source selected, "home" is that source's own resolved
  // location when it resolves; otherwise (including an unresolved single
  // source) it falls back to the instance-wide default.
  const goHomeDestination = useMemo<Coordinate | null>(() => {
    if (selectedSources.length === 1) {
      return resolveDestination(selectedSources[0]) ?? homeDestination
    }
    return homeDestination
  }, [selectedSources, resolveDestination, homeDestination])

  const goToHome = useCallback(() => {
    if (!goHomeDestination) return
    flyToCoordinate(goHomeDestination)
  }, [goHomeDestination, flyToCoordinate])

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

  const changeLiveOverlay = useCallback(
    (key: keyof LiveOverlayPreferences, enabled: boolean) => {
      setLiveOverlays((previous) => ({ ...previous, [key]: enabled }))
    },
    [],
  )

  // Handle map click: live packets first, then the markers layer
  const onClick = useCallback(
    (event: MapLayerMouseEvent) => {
      const liveFeature = event.features?.find((feature) =>
        feature.layer.id === "live-origin-core" || feature.layer.id === "live-packet-core",
      )
      if (liveFeature) {
        const requestId = liveFeature.properties?.requestId as string | undefined
        const request = requestId ? liveStore.getRequest(requestId) : undefined
        setPopup(null)
        // An evicted request has no detail left to show; the click still
        // dismisses whatever popup was open, like any other map click.
        setLivePopup(request ?? null)
        return
      }

      // Any click that does not land on a live packet dismisses whichever
      // live popup is open, regardless of the active layer - including the
      // heatmap, which has no marker click handling of its own below.
      setLivePopup(null)

      if (activeLayer !== "markers") {
        setPopup(null)
        return
      }

      const features = event.features
      if (!features?.length) {
        setPopup(null)
        return
      }

      const feature = features[0]
      const geometry = feature.geometry as Point

      // Handle cluster click - zoom in
      if (feature.properties?.cluster) {
        setPopup(null)
        const clusterId = feature.properties.cluster_id as number
        const source = mapRef.current?.getSource("geo-data") as GeoJSONSource
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
    [activeLayer, liveStore]
  )

  const handleLiveSelect = useCallback((request: LiveRequest) => {
    // Only one popup at a time: selecting a live request dismisses any open
    // location popup, matching what a direct packet click does.
    setPopup(null)
    setLivePopup(request)
    if (request.coordinates) {
      // replay() notifies LivePulses without storing anything.
      liveStore.replay(request)
      // Bring the origin into view; a popup anchored off-viewport is invisible.
      mapRef.current?.flyTo({
        center: request.coordinates,
        zoom: Math.max(mapRef.current.getZoom(), 5),
        duration: 1200,
      })
    }
  }, [liveStore])

  // Row tap from the mobile sheet: just the popup and a fly-to, deliberately
  // not handleLiveSelect - replaying an arc under a sheet about to close is
  // noise, and the fly-to is the feedback that matters here.
  const selectFromFeed = useCallback((request: LiveRequest) => {
    setPopup(null)
    setLivePopup(request)
    if (request.coordinates) {
      mapRef.current?.flyTo({ center: request.coordinates, zoom: 6, duration: 1200 })
    }
  }, [])

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
            data={geojson as unknown as FeatureCollection}
            cluster={activeLayer === "markers"}
            clusterMaxZoom={14}
            clusterRadius={50}
            clusterProperties={{
              // Sum event_count for all points in the cluster
              sum_event_count: ["+", ["get", "eventCount"]],
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

        {/* Live requests travelling from their GeoIP origin to their source's home. */}
        <LivePulses
          enabled={liveMode && routeEffectsEnabled}
          resolveDestination={resolveDestination}
        />

        {/* One beacon per site home, plus the default when it is distinct. */}
        {homeMarkerEnabled && beacons.map((coordinates) => (
          <HomeMarker
            key={`${coordinates[0]},${coordinates[1]}`}
            coordinates={coordinates}
            onClick={() => flyToCoordinate(coordinates)}
          />
        ))}

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

      {/* A request with no GeoIP match has nowhere on the map to anchor a
          Popup, so its detail renders as a centered card instead - it stays
          reachable from the strip and the sheet alike. */}
      {livePopup && !livePopup.coordinates && (
        <LiveRequestCard request={livePopup} onClose={() => setLivePopup(null)} />
      )}

      {liveMode && !isMobile && liveOverlays.rail && (
        <LiveRail onSelect={handleLiveSelect} />
      )}

      {/* Mobile: the vitals pill is the only way into the feed, so it mounts
          whenever live mode is on regardless of the desktop overlay preference. */}
      {liveMode && isMobile && (
        <div className="pointer-events-none absolute left-4 top-4 z-10">
          <LiveVitalsPill onOpenFeed={() => setFeedOpen(true)} />
        </div>
      )}

      {liveMode && isMobile && (
        <LiveFeedSheet open={feedOpen} onOpenChange={setFeedOpen} onSelect={selectFromFeed} />
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
        liveOverlays={liveOverlays}
        onLiveOverlayChange={changeLiveOverlay}
        routeEffectsEnabled={routeEffectsEnabled}
        onRouteEffectsChange={setRouteEffectsEnabled}
        routeHomeAvailable={goHomeDestination !== null}
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
        topIPs={globalTopIPs?.topIps ?? []}
        onFlyToLocation={flyToLocation}
        countryOptions={filterOptions.countries}
        countryLabels={filterOptions.countryLabels}
        cityOptions={filterOptions.cities}
        selectedCountries={selectedCountries}
        selectedCities={selectedCities}
        onCountriesChange={onCountriesChange}
        onCitiesChange={onCitiesChange}
        sourceOptions={sourceOptions}
        selectedSources={selectedSources}
        onSourcesChange={onSourcesChange}
        sourcesLoading={facetsLoading}
      />

    </div>
  )
}

export default function GeoMap() {
  const search = useSearch({ from: "/map" })
  const sources = search.sources ?? []
  const [liveMode, setLiveModeState] = useState(
    () => (getDemoTrafficMode() !== "off" ? true : loadLivePreference()),
  )
  const setLiveMode = (enabled: boolean) => {
    setLiveModeState(enabled)
    saveLivePreference(enabled)
  }

  return (
    <LiveTrafficProvider enabled={liveMode} sources={sources}>
      <GeoMapInner liveMode={liveMode} onLiveModeChange={setLiveMode} />
    </LiveTrafficProvider>
  )
}
