/**
 * Main map component with heatmap and cluster visualization layers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { toast } from "sonner"
import Map, {
  Source,
  Layer,
  NavigationControl,
  type MapRef,
  type ViewStateChangeEvent,
} from "react-map-gl/maplibre"
import "maplibre-gl/dist/maplibre-gl.css"
import type { Feature, FeatureCollection, GeoJsonProperties, Point } from "geojson"
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl"

import {
  useGeoJSON,
  useGlobalTopIPs,
  useRuntimeSettings,
  useBannedLocations,
  useCrowdsecStatus,
  useCrowdsecLiveUpdates,
  useGeoEventFacets,
  useSiteHomes,
  useIpLocations,
} from "@/lib/queries"
import { beaconLabel, buildHomeResolver, homeBeacons, type Coordinate, type SiteHomesData } from "@/lib/site-homes"
import { FIT_PADDING, initialMapView, WORLD_VIEW } from "@/lib/map-initial-view"
import { useMapStyle } from "./hooks/useMapStyle"
import { MapAttribution } from "./MapAttribution"
import {
  bannedPointLayer,
  bannedClusterLayer,
  bannedCountLayer,
  clusterCountLayer,
  clusterLayer,
  heatmapLayer,
  unclusteredPointLabelLayer,
  unclusteredPointLayer,
} from "./layers"
import { MapControls, type BannedSummary } from "./MapControls"
import { MapFrameRate } from "./MapFrameRate"
import { LivePulses } from "./LivePulses"
import { HomeMarker } from "./HomeMarker"
import { BannedMapPopup } from "./BannedMapPopup"
import { DecisionAlertSheet, type DecisionRef } from "@/components/security/alert-detail-sheet"
import { bannedClusterGroupIds, bannedGroupMembers, bannedGroupOf, indexBannedFeatures, topBannedIps, type BannedPopupInfo } from "@/lib/banned-map"
import { clusterIndex, nearestFirst, predictUnclusteredZoom, unclusteredZoom } from "@/lib/map-clusters"
import type { TopIPDTO } from "@/lib/api"
import { crowdsecErrorMessage } from "@/lib/crowdsec"
import { MapPopup, type PopupInfo } from "./MapPopup"
import { LiveRequestCard, LiveRequestPopup } from "./LiveRequestPopup"
import { LiveVitalsPill } from "./LiveVitalsPill"
import { LiveRail } from "./LiveRail"
import { LiveFeedSheet } from "./LiveFeedSheet"
import { MapBackdrop } from "@/components/brand/backdrops"
import { ErrorBanner } from "@/components/error-banner"
import { getDemoTrafficMode } from "@/lib/demo-traffic"
import { decodeMapSearch, encodeMapSearch } from "@/lib/map-filters"
import { useUrlFilters } from "@/hooks/use-url-filters"
import { loadLiveOverlays, saveLiveOverlays, type LiveOverlayPreferences } from "@/lib/live-overlays"
import {
  loadLayerPreference,
  loadFrameRatePreference,
  saveFrameRatePreference,
  loadLivePreference,
  saveLayerPreference,
  saveLivePreference,
} from "@/lib/map-preferences"
import { LiveTrafficProvider, useLiveTrafficStore } from "@/lib/live-traffic/context"
import type { LiveRequest } from "@/lib/live-traffic/types"
import { isPhoneViewport, useIsPhone } from "@/hooks/use-mobile"
import { MAPLIBRE_WORKER_URL } from "@/lib/maplibre-worker"

export type LayerType = "heatmap" | "markers" | "banned"
export type MapProjection = "mercator" | "globe"

// The desktop map controls open expanded over the map's right edge. The
// panel is 240px wide and sits 16px in, and the first view keeps homes out
// from under it.
const DESKTOP_CONTROLS_INSET = 240 + 16

// Placeholder until initialMapView resolves. The map mounts only after that.
const INITIAL_VIEW_STATE = {
  ...WORLD_VIEW,
  pitch: 0,
  bearing: 0,
}

const CLUSTER_MAX_ZOOM = 14
const CLUSTER_RADIUS = 50
// Past this many points, building the cluster index would stall the click,
// and the landing check does the zooming instead.
const PREDICT_MAX_FEATURES = 20_000

/** The source and layers a focused point renders in, and how to recognise it. */
interface ClusterTarget {
  sourceId: string
  /** The features the source was given, to predict its clustering. */
  features: Feature<Point>[]
  layerIds: string[]
  matches: (properties: GeoJsonProperties) => boolean
}

/** Whether the camera centre is within `tolerance` pixels of `center`. */
function isCentredOn(map: MapLibreMap, center: Coordinate, tolerance: number) {
  // The camera may have crossed the antimeridian, so compare wrapped.
  const here = map.project(map.getCenter().wrap())
  const there = map.project(center)
  return Math.hypot(here.x - there.x, here.y - there.y) < tolerance
}

function markerTarget(features: Feature<Point>[], locationId: number): ClusterTarget {
  return {
    sourceId: "geo-data",
    features,
    layerIds: ["clusters", "unclustered-point"],
    matches: (properties) => properties?.id === locationId,
  }
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
  const { mapStyle, transformRequest, ready: mapReady } = useMapStyle()
  const isPhone = useIsPhone()
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
  // The saved choice survives a disabled integration, but the map falls back
  // to markers until the status query confirms CrowdSec is enabled. A loading
  // or failed status request is not the same as disabled.
  const [layerPreference, setLayerPreference] = useState<LayerType>(loadLayerPreference)
  const {
    data: crowdsecStatus,
    isError: statusError,
    error: statusErrorDetail,
    refetch: refetchStatus,
  } = useCrowdsecStatus()
  const activeLayer: LayerType =
    layerPreference === "banned" && crowdsecStatus?.enabled === false ? "markers" : layerPreference
  useCrowdsecLiveUpdates(activeLayer === "banned")
  const { data: geojson, isLoading: isLoadingGeoJSON, isError, error } = useGeoJSON({
    enabled: activeLayer !== "banned",
    countryCodes: selectedCountries,
    cities: selectedCities,
    hostnames: selectedSources,
  })
  const { data: facets, isLoading: facetsLoading } = useGeoEventFacets()
  const sourceOptions = facets?.hostnames ?? []
  const { data: globalTopIPs, isLoading: isLoadingTopIPs } = useGlobalTopIPs({ enabled: activeLayer !== "banned" })
  const { data: runtimeSettings, isPending: runtimeSettingsPending } = useRuntimeSettings()
  const homeDestination = useMemo<Coordinate | null>(() => {
    const latitude = runtimeSettings?.map.homeLatitude
    const longitude = runtimeSettings?.map.homeLongitude
    return typeof latitude === "number" && typeof longitude === "number"
      ? [longitude, latitude]
      : null
  }, [runtimeSettings])
  const { data: siteHomes, isPending: siteHomesPending } = useSiteHomes()
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
  // The map mounts once the first view is known, so it doesn't open on a
  // placeholder and jump. On failure, both queries settle after one retry.
  const [initialViewResolved, setInitialViewResolved] = useState(false)
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const [projection, setProjection] = useState<MapProjection>(loadMapProjectionPreference)
  const [routeEffectsEnabled, setRouteEffectsEnabled] = useState(loadRouteEffectsPreference)
  const [frameRateEnabled, setFrameRateEnabled] = useState(loadFrameRatePreference)
  useEffect(() => saveFrameRatePreference(frameRateEnabled), [frameRateEnabled])
  const [homeMarkerEnabled, setHomeMarkerEnabled] = useState(loadHomeMarkerPreference)
  const [liveOverlays, setLiveOverlays] = useState<LiveOverlayPreferences>(loadLiveOverlays)
  const [popup, setPopup] = useState<PopupInfo | null>(null)

  // Flies to a Top IPs row or the inspector's ?focus target at the zoom
  // where it leaves its cluster, then checks the landing against the
  // rendered clusters and zooms on if the map still clusters it. The camera
  // moves carry the generation. Any other move start, a map click or a
  // closed popup cancels the check.
  const focusGeneration = useRef(0)
  const stopFocusListeners = useRef<(() => void) | null>(null)
  const cancelFocus = useCallback(() => {
    focusGeneration.current++
    stopFocusListeners.current?.()
    stopFocusListeners.current = null
  }, [])
  useEffect(() => cancelFocus, [cancelFocus])
  const focusOn = useCallback((center: Coordinate, target?: ClusterTarget) => {
    const map = mapRef.current?.getMap()
    if (!map) return
    cancelFocus()
    const generation = focusGeneration.current
    const eventData = { focusGeneration: generation }
    let landingZoom = Math.max(map.getZoom(), 7)
    // Predicts the zoom where the target leaves its cluster from the index
    // the source builds, so one flight lands there.
    if (target && target.features.length <= PREDICT_MAX_FEATURES) {
      const index = clusterIndex(target.features, CLUSTER_RADIUS, CLUSTER_MAX_ZOOM)
      const maxZoom = Math.min(CLUSTER_MAX_ZOOM + 1, map.getMaxZoom())
      landingZoom = predictUnclusteredZoom(index, center, target.matches, landingZoom, maxZoom)
    }
    const arrived = isCentredOn(map, center, 2) && Math.abs(map.getZoom() - landingZoom) < 0.01
    if (target) {
      let passes = 0
      let timer: number | undefined
      const stop = () => {
        window.clearTimeout(timer)
        map.off("moveend", onMoveEnd)
        map.off("render", settle)
      }
      // Waits for the target source, not map idle. The live routes animate
      // their own source, which can hold idle off indefinitely.
      const settle = () => {
        const source = map.getSource<GeoJSONSource>(target.sourceId)
        const layers = target.layerIds.filter((id) => map.getLayer(id))
        if (!source || layers.length === 0) return stop()
        // react-map-gl holds the camera at the last rendered view state until
        // React catches up, so wait for the landing to arrive. An ease comes
        // in from below, so a lagging 6.998 still draws zoom 6 tiles. A
        // flight a gesture cut short never arrives and runs into the timeout.
        const zoom = map.getZoom()
        const landed = isCentredOn(map, center, 2)
          && Math.floor(zoom) === Math.floor(landingZoom)
          && Math.abs(zoom - landingZoom) < 0.01
        if (!landed || !map.isSourceLoaded(target.sourceId)) return
        window.clearTimeout(timer)
        map.off("render", settle)
        // A cluster is drawn at its members' centroid, up to four radii away
        // from a member.
        const candidates = nearestFirst(map.queryRenderedFeatures({ layers }), center, zoom, CLUSTER_RADIUS * 4)
        const maxZoom = Math.min(CLUSTER_MAX_ZOOM + 1, map.getMaxZoom())
        unclusteredZoom(source, candidates, target.matches, zoom, maxZoom)
          .then((next) => {
            const current = generation === focusGeneration.current && source === map.getSource(target.sourceId)
            // The landing is checked again after each zoom-in, in case the
            // tiles at that zoom still cluster the target.
            if (current && next !== undefined && next > zoom && passes++ < 3) {
              landingZoom = next
              map.easeTo({ center, zoom: next, duration: 800 }, eventData)
            } else {
              stop()
            }
          })
          // A data refresh mid-descent retires the cluster ids. The camera
          // stays where it landed.
          .catch(stop)
      }
      const onMoveEnd = (event: unknown) => {
        if ((event as { focusGeneration?: number }).focusGeneration !== generation) return
        map.on("render", settle)
        map.triggerRepaint()
        window.clearTimeout(timer)
        timer = window.setTimeout(stop, 3000)
      }
      // Registered before the flight: with reduced motion, flyTo jumps and
      // fires moveend synchronously.
      map.on("moveend", onMoveEnd)
      stopFocusListeners.current = stop
    }
    map.flyTo({ center, zoom: landingZoom, duration: arrived ? 0 : 1500 }, eventData)
  }, [cancelFocus])
  const onMoveStart = useCallback((event: ViewStateChangeEvent) => {
    if ((event as { focusGeneration?: number }).focusGeneration !== focusGeneration.current) cancelFocus()
  }, [cancelFocus])

  const liveStore = useLiveTrafficStore()
  const [livePopup, setLivePopup] = useState<LiveRequest | null>(null)
  const [feedOpen, setFeedOpen] = useState(false)
  // The IP inspector navigates here with ?focus=<locationId> and the data
  // filters cleared, so the feature is in this payload once it loads. The
  // GeoJSON can arrive from the query cache before the map has a style, so
  // the fly-to also waits for the map's load event.
  const [mapLoaded, setMapLoaded] = useState(false)
  const focusId = search.focus
  // Callers that only know an address arrive with ?focusIp=<ip>; resolve it
  // to the IP's busiest location in range and rewrite it as ?focus so the
  // fly-to below takes over. The rows come sorted by event count.
  const focusIp = search.focusIp
  const focusIpQuery = useIpLocations(focusIp)
  useEffect(() => {
    if (focusIp === undefined || focusIpQuery.isPending) return
    const locationId = focusIpQuery.data?.items?.[0]?.locationId
    if (focusIpQuery.isError) {
      toast.error("Could not look up the IP", { description: `The locations for ${focusIp} failed to load.` })
    } else if (locationId === undefined) {
      toast.info("IP not on the map", {
        description: `${focusIp} has no geo events in the selected time range.`,
      })
    }
    void navigate({ search: (prev) => ({ ...prev, focusIp: undefined, focus: locationId }), replace: true })
  }, [focusIp, focusIpQuery.isPending, focusIpQuery.isError, focusIpQuery.data, navigate])

  const bannedQuery = useBannedLocations(activeLayer === "banned", {
    countryCodes: selectedCountries, cities: selectedCities, hostnames: selectedSources,
  })
  const bannedLocations = bannedQuery.data
  const bannedIndex = useMemo(() => indexBannedFeatures(bannedLocations), [bannedLocations])
  const bannedTopIps = useMemo(() => topBannedIps(bannedLocations), [bannedLocations])
  // The selection stores group ids, not IPs, so the popup follows the current
  // data. A refetch that unbans one IP drops it from the list, and a group
  // that disappears closes the popup, with no effect per data change.
  const [bannedPopup, setBannedPopup] = useState<BannedPopupInfo | null>(null)
  // Outside the popup, which unmounts once an unban or expiry empties its location.
  const [bannedAlert, setBannedAlert] = useState<DecisionRef | null>(null)
  const bannedPopupIps = useMemo(
    () => (bannedPopup ? bannedGroupMembers(bannedPopup.groupIds, bannedIndex) : []),
    [bannedPopup, bannedIndex],
  )
  // Bumped by every selection change so an async cluster expansion started
  // before it cannot reopen a popup the user has since dismissed.
  const clickGeneration = useRef(0)
  const closeBannedPopup = useCallback(() => {
    clickGeneration.current++
    cancelFocus()
    setBannedPopup(null)
  }, [cancelFocus])
  const changeLayer = useCallback((layer: LayerType) => {
    setLayerPreference(layer)
    closeBannedPopup()
  }, [closeBannedPopup])
  const bannedSummary: BannedSummary = {
    stats: bannedLocations?.stats,
    loading: bannedQuery.isPending && !statusError,
    error: bannedQuery.isError || statusError
      ? crowdsecErrorMessage(bannedQuery.error ?? statusErrorDetail, "Try again in a moment.")
      : undefined,
    unreachable: crowdsecStatus?.lapiReachable === false,
    onRetry: () => {
      void refetchStatus()
      void bannedQuery.refetch()
    },
  }
  useEffect(() => {
    // The inspector's fly-to lands on a traffic marker, which only exists
    // on the markers layer.
    if (focusId !== undefined && activeLayer === "banned") {
      setLayerPreference("markers")
      return
    }
    if (focusId === undefined || !mapLoaded || isLoadingGeoJSON || !geojson) return
    const feature = geojson.features.find((f) => f.properties?.id === focusId)
    if (feature) {
      const [lng, lat] = (feature.geometry as Point).coordinates
      setLivePopup(null)
      setPopup({ longitude: lng, latitude: lat, properties: feature.properties as PopupInfo["properties"] })
      focusOn([lng, lat], markerTarget(geojson.features as unknown as Feature<Point>[], focusId))
    } else {
      toast.info("Location not on the map", {
        description: "It has no geo events in the selected time range.",
      })
    }
    void navigate({ search: (prev) => ({ ...prev, focus: undefined }), replace: true })
  }, [focusId, activeLayer, geojson, isLoadingGeoJSON, mapLoaded, navigate, focusOn])
  const fitData = activeLayer === "banned" ? bannedLocations : geojson
  const mercatorZoomRef = useRef(INITIAL_VIEW_STATE.zoom)

  useEffect(() => {
    if (initialViewResolved || runtimeSettingsPending || siteHomesPending) return
    const rect = mapContainerRef.current?.getBoundingClientRect()
    const view = initialMapView({
      defaultView: runtimeSettings?.map.defaultView,
      siteHomes: siteHomesData,
      selectedSources,
      size: { width: rect?.width ?? 0, height: rect?.height ?? 0 },
      padding: {
        top: FIT_PADDING,
        // Not useIsPhone, which reads false on the first render. With both
        // queries cached, this effect resolves the view in that same render.
        right: FIT_PADDING + (isPhoneViewport() ? 0 : DESKTOP_CONTROLS_INSET),
        bottom: FIT_PADDING,
        left: FIT_PADDING,
      },
    })
    setViewState((previous) => ({ ...previous, ...view }))
    mercatorZoomRef.current = view.zoom
    setInitialViewResolved(true)
  }, [
    initialViewResolved,
    runtimeSettingsPending,
    siteHomesPending,
    runtimeSettings,
    siteHomesData,
    selectedSources,
  ])

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
    saveLayerPreference(layerPreference)
  }, [layerPreference])

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
    if (!fitData?.features.length || !mapRef.current) return

    // Single pass: spreading thousands of coordinates into Math.min/max
    // can blow the call stack.
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
    for (const f of fitData.features) {
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
  }, [fitData])

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
      cancelFocus()
      const generation = ++clickGeneration.current
      setBannedPopup(null)
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

      if (activeLayer === "banned") {
        setPopup(null)
        const feature = event.features?.find((item) => item.layer.id === "banned-clusters" || item.layer.id === "banned-points")
        if (!feature) return
        const geometry = feature.geometry as Point
        const [longitude, latitude] = geometry.coordinates
        const source = mapRef.current?.getSource("banned-data") as GeoJSONSource | undefined
        if (feature.properties?.cluster && source) {
          // A layer switch recreates the source, so a stale expansion also
          // fails the identity check.
          const isCurrent = () =>
            generation === clickGeneration.current && source === mapRef.current?.getSource("banned-data")
          const clusterId = Number(feature.properties.cluster_id)
          void (async () => {
            try {
              const zoom = await source.getClusterExpansionZoom(clusterId)
              if (!isCurrent()) return
              const map = mapRef.current
              // Expansion past clusterMaxZoom would just stack the leaves.
              // Browse that terminal cluster instead of hiding its members.
              if (map && zoom > map.getZoom() && zoom <= Math.min(14, map.getMaxZoom())) {
                map.easeTo({ center: [longitude, latitude], zoom, duration: 500 })
                return
              }
              const groupIds = await bannedClusterGroupIds(source, clusterId, Number(feature.properties.point_count))
              if (isCurrent() && groupIds.length) setBannedPopup({ longitude, latitude, groupIds })
            } catch {
              if (isCurrent()) toast.error("Could not open this cluster. Try again.")
            }
          })()
          return
        }
        // At high zoom, several distinct groups can still overlap on screen.
        const groupIds = event.features
          ?.filter((item) => item.layer.id === "banned-points")
          .map((item) => String(item.properties.groupId)) ?? []
        if (groupIds.length) setBannedPopup({ longitude, latitude, groupIds })
        return
      }

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
    [activeLayer, liveStore, bannedIndex]
  )

  const selectTopIp = useCallback((ip: TopIPDTO) => {
    const location = ip.location
    if (!location) return
    closeBannedPopup()
    setLivePopup(null)
    setPopup(null)
    if (activeLayer === "markers") {
      const features = geojson?.features ?? []
      const feature = features.find((f) => f.properties?.id === location.id)
      if (feature) {
        const [lng, lat] = (feature.geometry as Point).coordinates
        setPopup({ longitude: lng, latitude: lat, properties: feature.properties as PopupInfo["properties"] })
        focusOn([lng, lat], markerTarget(features as unknown as Feature<Point>[], location.id))
        return
      }
    } else if (activeLayer === "banned") {
      const group = bannedGroupOf(ip.ipAddress, bannedIndex)
      if (group) {
        const [lng, lat] = group.geometry.coordinates
        const groupId = group.properties.groupId
        setBannedPopup({ longitude: lng, latitude: lat, groupIds: [groupId] })
        focusOn([lng, lat], {
          sourceId: "banned-data",
          features: bannedLocations?.features ?? [],
          layerIds: ["banned-clusters", "banned-points"],
          matches: (properties) => properties?.groupId === groupId,
        })
        return
      }
    }
    // Filters can hide the row's location, and the heatmap has no popup.
    focusOn([location.longitude, location.latitude])
  }, [activeLayer, geojson, bannedIndex, bannedLocations, closeBannedPopup, focusOn])

  const handleLiveSelect = useCallback((request: LiveRequest) => {
    // Only one popup at a time: selecting a live request dismisses any open
    // location popup, matching what a direct packet click does.
    closeBannedPopup()
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
  }, [liveStore, closeBannedPopup])

  // Row tap from the mobile sheet: just the popup and a fly-to, deliberately
  // not handleLiveSelect - replaying an arc under a sheet about to close is
  // noise, and the fly-to is the feedback that matters here.
  const selectFromFeed = useCallback((request: LiveRequest) => {
    closeBannedPopup()
    setPopup(null)
    setLivePopup(request)
    if (request.coordinates) {
      mapRef.current?.flyTo({ center: request.coordinates, zoom: 6, duration: 1200 })
    }
  }, [closeBannedPopup])

  if (!mapReady || !initialViewResolved) {
    return (
      <div ref={mapContainerRef} className="relative h-full w-full overflow-hidden bg-background">
        <MapBackdrop tone="quiet" />
      </div>
    )
  }

  return (
    <div className="h-full w-full relative">
      <Map
        ref={mapRef}
        workerUrl={MAPLIBRE_WORKER_URL}
        {...viewState}
        onLoad={() => setMapLoaded(true)}
        onMoveStart={onMoveStart}
        onMove={onMove}
        onClick={onClick}
        mapStyle={mapStyle}
        transformRequest={transformRequest}
        projection={projection}
        renderWorldCopies={projection === "mercator"}
        interactiveLayerIds={[
          ...(activeLayer === "markers" ? ["clusters", "unclustered-point"] : []),
          ...(activeLayer === "banned" && bannedLocations ? ["banned-clusters", "banned-points"] : []),
          ...(liveMode && routeEffectsEnabled ? ["live-origin-core", "live-packet-core"] : []),
        ]}
        cursor={activeLayer !== "heatmap" ? "pointer" : "grab"}
        attributionControl={false}
      >
        {/* Navigation controls */}
        <NavigationControl position="bottom-right" showCompass={true} />
        {frameRateEnabled && <MapFrameRate />}
        <MapAttribution />

        {/* GeoJSON data source */}
        {/* The `key` only flips when the clustering requirement changes (markers
            need clustering, heatmap does not). MapLibre reads `cluster` only at
            source creation, so a layer switch must recreate the source for the
            new clustering state to take effect - otherwise flipping back to
            markers never regroups the points. Within a single layer the key is
            stable, so data refreshes still diff via setData without remounting
            (which would tear down and re-add every layer). */}
        {geojson && activeLayer !== "banned" && (
          <Source
            key={activeLayer === "markers" ? "clustered" : "plain"}
            id="geo-data"
            type="geojson"
            data={geojson as unknown as FeatureCollection}
            cluster={activeLayer === "markers"}
            clusterMaxZoom={CLUSTER_MAX_ZOOM}
            clusterRadius={CLUSTER_RADIUS}
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

        {activeLayer === "banned" && bannedLocations && (
          <Source
            id="banned-data"
            type="geojson"
            data={bannedLocations}
            cluster
            clusterMaxZoom={CLUSTER_MAX_ZOOM}
            clusterRadius={CLUSTER_RADIUS}
            clusterProperties={{ ipCount: ["+", ["get", "ipCount"]] }}
          >
            <Layer {...bannedClusterLayer} />
            <Layer {...bannedPointLayer} />
            <Layer {...bannedCountLayer} />
          </Source>
        )}

        {/* Live requests travelling from their GeoIP origin to their source's home. */}
        <LivePulses
          enabled={liveMode && routeEffectsEnabled}
          resolveDestination={resolveDestination}
        />

        {/* One beacon per site home, plus the default when it is distinct. */}
        {homeMarkerEnabled && beacons.map((beacon) => (
          <HomeMarker
            key={`${beacon.coordinate[0]},${beacon.coordinate[1]}`}
            coordinates={beacon.coordinate}
            label={beaconLabel(beacon)}
            onClick={() => flyToCoordinate(beacon.coordinate)}
          />
        ))}

        {activeLayer === "banned" && bannedPopup && bannedPopupIps.length > 0 && (
          <BannedMapPopup
            key={bannedPopup.groupIds.join("|")}
            longitude={bannedPopup.longitude}
            latitude={bannedPopup.latitude}
            ips={bannedPopupIps}
            onClose={closeBannedPopup}
            onOpenAlert={setBannedAlert}
          />
        )}

        {/* Popup */}
        {popup && activeLayer === "markers" && (
          <MapPopup
            longitude={popup.longitude}
            latitude={popup.latitude}
            properties={popup.properties}
            onClose={() => {
              cancelFocus()
              setPopup(null)
            }}
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

      {/* Fly to would clear the map filters and switch off the Banned IPs
          layer, only to land on the IP already in view. */}
      <DecisionAlertSheet
        decision={bannedAlert}
        onOpenChange={(open) => !open && setBannedAlert(null)}
        showFlyTo={false}
      />

      {liveMode && !isPhone && liveOverlays.rail && (
        <LiveRail onSelect={handleLiveSelect} />
      )}

      {/* Mobile: the vitals pill is the only way into the feed, so it mounts
          whenever live mode is on regardless of the desktop overlay preference. */}
      {liveMode && isPhone && (
        <div className="pointer-events-none absolute left-[max(1rem,env(safe-area-inset-left))] top-[max(1rem,env(safe-area-inset-top))] z-10">
          <LiveVitalsPill onOpenFeed={() => setFeedOpen(true)} />
        </div>
      )}

      {liveMode && isPhone && (
        <LiveFeedSheet open={feedOpen} onOpenChange={setFeedOpen} onSelect={selectFromFeed} />
      )}

      {/* Centered like LiveRequestCard so it never collides with the rail,
          the controls panel or the zoom buttons, and the controls stay
          reachable for switching to a layer that still has data. */}
      {isError && activeLayer !== "banned" && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4">
          <ErrorBanner
            className="pointer-events-auto w-full max-w-md backdrop-blur-[2px]"
            title="Failed to load map data"
            detail={`${(error?.message ?? "Unknown error occurred").replace(/\.$/, "")}. Make sure the backend server is running.`}
          />
        </div>
      )}

      {/* Controls overlay */}
      <MapControls
        activeLayer={activeLayer}
        onLayerChange={changeLayer}
        projection={projection}
        onProjectionChange={changeProjection}
        liveMode={liveMode}
        demoTrafficMode={demoTrafficMode}
        onLiveModeChange={onLiveModeChange}
        liveOverlays={liveOverlays}
        onLiveOverlayChange={changeLiveOverlay}
        routeEffectsEnabled={routeEffectsEnabled}
        frameRateEnabled={frameRateEnabled}
        onFrameRateChange={setFrameRateEnabled}
        onRouteEffectsChange={setRouteEffectsEnabled}
        routeHomeAvailable={goHomeDestination !== null}
        homeMarkerEnabled={homeMarkerEnabled}
        onHomeMarkerChange={setHomeMarkerEnabled}
        bannedAvailable={crowdsecStatus?.enabled !== false}
        banned={bannedSummary}
        onFitBounds={fitToBounds}
        onGoHome={goToHome}
        isLoading={activeLayer === "banned" ? bannedSummary.loading : isLoading}
        featureStats={geojson?.stats ?? { events: 0, countries: 0, cities: 0, locations: 0 }}
        topIPs={activeLayer === "banned" ? bannedTopIps : globalTopIPs?.topIps ?? []}
        onSelectIp={selectTopIp}
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
