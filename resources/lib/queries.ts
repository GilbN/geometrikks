/**
 * TanStack Query hooks for GeoMetrikks API.
 */

import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  fetchSummary,
  fetchLiveSummary,
  fetchGeoJSON,
  fetchGeoTimeSeries,
  fetchGlobalTopIPs,
  fetchLocationTopIPs,
  fetchTimeSeries,
  fetchTopCountries,
  fetchTopCityStats,
  fetchTopCountryStats,
  fetchTopIpStats,
  fetchTopUrls,
  fetchTopAsns,
  fetchTopUserAgents,
  fetchCumulativeTimeSeries,
  fetchAccessLogs,
  fetchAccessLogFacets,
  fetchGeoLogs,
  fetchGeoLogSummary,
  fetchGeoLogTimeSeries,
  fetchGeoLogTopIps,
  fetchGeoLogTopCountries,
  fetchGeoLogTopCities,
  fetchGeoEventFacets,
  deleteSiteHome,
  fetchSiteHomes,
  fetchRuntimeSettings,
  fetchSystemSettings,
  fetchSchedulerJobs,
  fetchAbout,
  fetchChangelog,
  fetchAsnClassification,
  fetchHealth,
  fetchMe,
  fetchStats,
  fetchCrowdsecStatus,
  fetchCrowdsecBannedIps,
  fetchCrowdsecStats,
  fetchCrowdsecDecisions,
  fetchCrowdsecAlerts,
  fetchCrowdsecBannedLocations,
  fetchCrowdsecDecisionLookup,
  fetchIpProfile,
  banIp,
  unbanIp,
  parseTimeRange,
  resolveChartGranularity,
  type GeoLogSortField,
  type GeoLogSortOrder,
  type SummaryParams,
  type GlobalTopIPsResponse,
  type LocationTopIPsResponse,
  type TopCountriesResponse,
  type CumulativeTimeSeriesResponse,
  type AccessLogsPage,
  type AccessLogFacets,
  type AccessLogSortField,
  type SortOrder,
  type CrowdSecStatusResponse,
  fetchAccessLogDebug,
  fetchAccessLogDebugStats,
  type AccessLogDebugPage,
  type AccessLogDebugSortField,
  type AccessLogDebugStats,
} from "./api"
import {
  applyBannedIpsDelta,
  applyStatusFrame,
  parseCrowdsecFrame,
} from "./crowdsec-live"
import {
  apiV1LogsFilesListFiles,
  apiV1LogsTailTail,
  apiV1SystemDatabaseGetDatabaseInfo,
} from "@/generated/api/sdk.gen"
import type { LogRecord } from "./logstream"
import { useTimeRange } from "./time-range-context"
import { currentBuildKey, hasUnseenChanges, saveSeenBuild, useSeenBuild } from "./changelog-seen"
import { useAnalyticsFilters } from "./analytics-filters-context"
import { useGeoLogFilters } from "./geo-log-filters-context"

// ============================================================================
// Query Keys
// ============================================================================

export const queryKeys = {
  settings: ["settings"] as const,
  auth: {
    me: ["auth", "me"] as const,
  },
  system: {
    settings: ["system", "settings"] as const,
    schedulerJobs: ["system", "scheduler-jobs"] as const,
    about: ["system", "about"] as const,
    changelog: ["system", "changelog"] as const,
    asnClassification: ["system", "asn-classification"] as const,
    stats: ["system", "stats"] as const,
    database: ["system", "database"] as const,
  },
  crowdsec: {
    status: ["crowdsec", "status"] as const,
    bannedIps: ["crowdsec", "banned-ips"] as const,
    stats: ["crowdsec", "stats"] as const,
    bannedLocations: (params: Record<string, unknown>, refreshKey?: number) =>
      ["crowdsec", "banned-locations", params, refreshKey] as const,
    decisions: (params: Record<string, unknown>) =>
      ["crowdsec", "decisions", params] as const,
    alerts: (params: Record<string, unknown>) =>
      ["crowdsec", "alerts", params] as const,
    lookup: (ip: string, refreshKey?: number) => ["crowdsec", "lookup", ip, refreshKey] as const,
    latestAlert: (ip: string, refreshKey?: number) => ["crowdsec", "latest-alert", ip, refreshKey] as const,
  },
  analytics: {
    all: ["analytics"] as const,
    summary: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "summary", params, refreshKey] as const,
    liveSummary: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "live-summary", params, refreshKey] as const,
    cumulativeTimeSeries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "cumulative-time-series", params, refreshKey] as const,
    timeSeries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "time-series", params, refreshKey] as const,
    geoTimeSeries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "geo-time-series", params, refreshKey] as const,
    topUrls: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "top-urls", params, refreshKey] as const,
    topUserAgents: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "top-user-agents", params, refreshKey] as const,
    topAsns: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "top-asns", params, refreshKey] as const,
    topIps: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "top-ips", params, refreshKey] as const,
    topCountryStats: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "top-country-stats", params, refreshKey] as const,
    topCityStats: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "top-city-stats", params, refreshKey] as const,
    ipProfile: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "ip-profile", params, refreshKey] as const,
  },
  geo: {
    all: ["geo"] as const,
    geojson: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geo.all, "geojson", params, refreshKey] as const,
    globalTopIPs: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geo.all, "global-top-ips", params, refreshKey] as const,
    locationTopIPs: (locationId: number, params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geo.all, "location-top-ips", locationId, params, refreshKey] as const,
    topCountries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geo.all, "top-countries", params, refreshKey] as const,
    siteHomes: ["geo", "site-homes"] as const,
  },
  accessLogs: {
    all: ["access-logs"] as const,
    list: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.accessLogs.all, "list", params, refreshKey] as const,
    facets: () => [...queryKeys.accessLogs.all, "facets"] as const,
  },
  accessLogDebug: {
    all: ["access-log-debug"] as const,
    list: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.accessLogDebug.all, "list", params, refreshKey] as const,
    stats: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.accessLogDebug.all, "stats", params, refreshKey] as const,
  },
  geoLogs: {
    all: ["geo-logs"] as const,
    list: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geoLogs.all, "list", params, refreshKey] as const,
    summary: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geoLogs.all, "summary", params, refreshKey] as const,
    timeSeries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geoLogs.all, "time-series", params, refreshKey] as const,
    topIps: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geoLogs.all, "top-ips", params, refreshKey] as const,
    topCountries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geoLogs.all, "top-countries", params, refreshKey] as const,
    topCities: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geoLogs.all, "top-cities", params, refreshKey] as const,
    geojson: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geoLogs.all, "geojson", params, refreshKey] as const,
    facets: () => [...queryKeys.geoLogs.all, "facets"] as const,
  },
  logs: {
    tail: (lines: number, source: "app" | "login") => ["logs", "tail", lines, source] as const,
    files: ["logs", "files"] as const,
  },
  ipInspector: {
    locations: (params: Record<string, unknown>, refreshKey?: number) =>
      ["ip-inspector", "locations", params, refreshKey] as const,
    latestRequests: (params: Record<string, unknown>, refreshKey?: number) =>
      ["ip-inspector", "latest-requests", params, refreshKey] as const,
  },
}

// ============================================================================
// Hooks
// ============================================================================

export function useRuntimeSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: fetchRuntimeSettings,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useSystemSettings() {
  return useQuery({
    queryKey: queryKeys.system.settings,
    queryFn: fetchSystemSettings,
    staleTime: 60_000,
  })
}

export function useSchedulerJobs() {
  return useQuery({
    queryKey: queryKeys.system.schedulerJobs,
    queryFn: fetchSchedulerJobs,
    refetchInterval: 5000,
  })
}

export function useAbout() {
  return useQuery({
    queryKey: queryKeys.system.about,
    queryFn: fetchAbout,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useChangelog() {
  return useQuery({
    queryKey: queryKeys.system.changelog,
    queryFn: fetchChangelog,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/**
 * True while the running build differs from the one the user last opened
 * the Changelog page on. A browser that has never stored a build adopts
 * the current one silently, so a fresh install shows no dot.
 */
export function useChangelogUnseen(): boolean {
  const { data } = useAbout()
  const seen = useSeenBuild()
  const current = data ? currentBuildKey(data.app) : null
  useEffect(() => {
    if (current && seen === null) saveSeenBuild(current)
  }, [current, seen])
  return hasUnseenChanges(seen, current)
}

/** The vendored hosting-ASN list; fetched only while its dialog is open. */
export function useAsnClassification(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.system.asnClassification,
    queryFn: fetchAsnClassification,
    staleTime: Number.POSITIVE_INFINITY,
    enabled,
  })
}

/** Shares the ["health"] cache with the sidebar LiveIndicator's 10s poll. */
export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
    retry: 1,
  })
}

/** Ingestion counters for the Status page; polls while mounted. */
export function useStats() {
  return useQuery({
    queryKey: queryKeys.system.stats,
    queryFn: fetchStats,
    refetchInterval: 10_000,
  })
}

/** Database size/version/hypertable stats for the Status page. Catalog
 *  queries only, but still polled slowly. */
export function useDatabaseInfo() {
  return useQuery({
    queryKey: queryKeys.system.database,
    queryFn: async () => {
      const { data } = await apiV1SystemDatabaseGetDatabaseInfo({ throwOnError: true })
      return data
    },
    refetchInterval: 60_000,
  })
}

// ============================================================================
// Auth
// ============================================================================

export function useMe() {
  return useQuery({
    queryKey: queryKeys.auth.me,
    queryFn: fetchMe,
    // The API 401s for an anonymous caller and the axios interceptor
    // redirects; retrying would just repeat that.
    retry: false,
    staleTime: Infinity,
  })
}

// ============================================================================
// CrowdSec
// ============================================================================

/** Whether the CrowdSec integration is configured; gates all CrowdSec UI.
 *  The 30s poll is a safety net for blocked WebSockets; live reachability
 *  changes arrive over /ws/crowdsec and are patched into this cache. */
export function useCrowdsecStatus() {
  return useQuery({
    queryKey: queryKeys.crowdsec.status,
    queryFn: fetchCrowdsecStatus,
    staleTime: 60_000,
    refetchInterval: 30_000,
  })
}

/** Set of currently banned IPs (all origins, CAPI included) for badge
 *  rendering; empty until the integration is enabled and loaded. */
export function useBannedIps() {
  const { data: status } = useCrowdsecStatus()
  return useQuery({
    queryKey: queryKeys.crowdsec.bannedIps,
    queryFn: fetchCrowdsecBannedIps,
    enabled: status?.enabled === true,
    refetchInterval: 60_000,
    select: (ips) => new Set(ips),
  })
}

/** Coordinates for the map's banned-IP overlay; fetched only while the
 *  overlay is switched on and the integration is enabled. Follows the
 *  global time range so every red marker has a matching traffic circle. */
export function useBannedLocations(active: boolean) {
  const { data: status } = useCrowdsecStatus()
  const { range, customRange, lastRefresh } = useTimeRange()
  return useQuery({
    queryKey: queryKeys.crowdsec.bannedLocations({ range, customRange }, lastRefresh),
    // Compute the date range at fetch time so refetches get fresh bounds
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchCrowdsecBannedLocations({
        fromTimestamp: startDate,
        toTimestamp: endDate,
      })
    },
    enabled: active && status?.enabled === true,
    refetchInterval: 60_000,
  })
}

/** Decision counts by origin + top scenarios for the Security stat cards. */
export function useCrowdsecStats() {
  const { data: status } = useCrowdsecStatus()
  return useQuery({
    queryKey: queryKeys.crowdsec.stats,
    queryFn: fetchCrowdsecStats,
    enabled: status?.enabled === true,
    refetchInterval: 60_000,
  })
}

/** One server-paginated page of active decisions for the Security table. */
export function useCrowdsecDecisions(params: {
  origins?: string
  currentPage: number
  pageSize: number
}) {
  const { data: status } = useCrowdsecStatus()
  return useQuery({
    queryKey: queryKeys.crowdsec.decisions(params),
    queryFn: () => fetchCrowdsecDecisions(params),
    enabled: status?.enabled === true,
    placeholderData: (previous) => previous,
    refetchInterval: 60_000,
  })
}

/** Recent alert history; only fetched when machine credentials are set. */
export function useCrowdsecAlerts(params: { since?: string; limit?: number }) {
  const { data: status } = useCrowdsecStatus()
  return useQuery({
    queryKey: queryKeys.crowdsec.alerts(params),
    queryFn: () => fetchCrowdsecAlerts(params),
    enabled: status?.writeEnabled === true,
    placeholderData: (previous) => previous,
    refetchInterval: 60_000,
  })
}

/** Ban an IP, then refresh badges, decisions, and stats. */
export function useBanIp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      ip,
      duration,
      reason,
    }: {
      ip: string
      duration?: string
      reason?: string
    }) => banIp(ip, duration, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["crowdsec"] }),
  })
}

/** Remove all active decisions for an IP, then refresh badges/decisions/stats. */
export function useUnbanIp() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (ip: string) => unbanIp(ip),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["crowdsec"] }),
  })
}

/** Live badge + reachability updates: subscribes to /ws/crowdsec while the
 *  integration is enabled, patches the cached banned-IP list on each delta,
 *  and patches cached /crowdsec/status on reachability frames (invalidating
 *  all CrowdSec queries on recovery). Reconnects with capped exponential
 *  backoff, same policy as /ws/live. */
export function useCrowdsecLiveUpdates() {
  const { data: status } = useCrowdsecStatus()
  const queryClient = useQueryClient()
  const enabled = status?.enabled === true

  useEffect(() => {
    if (!enabled) return
    let ws: WebSocket | null = null
    let closed = false
    let retryMs = 1000
    let timer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss" : "ws"
      ws = new WebSocket(`${proto}://${window.location.host}/ws/crowdsec`)
      ws.onmessage = (msg) => {
        const frame = parseCrowdsecFrame(msg.data)
        if (!frame) return
        // Reset backoff only on a valid frame, not onopen: the server accepts
        // and immediately closes 1013 while the poller is down, so an onopen
        // reset would pin the reconnect loop at the 1s floor.
        retryMs = 1000
        if (frame.type === "crowdsec_status") {
          const previous = queryClient.getQueryData<CrowdSecStatusResponse>(
            queryKeys.crowdsec.status,
          )
          queryClient.setQueryData<CrowdSecStatusResponse>(
            queryKeys.crowdsec.status,
            (status) => applyStatusFrame(status, frame),
          )
          // Recovery: refetch decisions/alerts/stats immediately so the page
          // leaves its stale state without waiting for the 60s intervals.
          if (frame.lapi_reachable && previous?.lapiReachable === false) {
            queryClient.invalidateQueries({ queryKey: ["crowdsec"] })
          }
          return
        }
        queryClient.setQueryData<string[]>(
          queryKeys.crowdsec.bannedIps,
          (ips) => applyBannedIpsDelta(ips, frame),
        )
      }
      ws.onclose = () => {
        if (closed) return
        timer = setTimeout(connect, retryMs)
        retryMs = Math.min(retryMs * 2, 30_000)
      }
    }

    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      ws?.close()
    }
  }, [enabled, queryClient])
}

export interface UseSummaryOptions {
  /** Compare with previous period (default: true) */
  comparePrevious?: boolean
  /** Enable/disable the query */
  enabled?: boolean
}

/**
 * Fetch summary statistics for the dashboard.
 * Uses statsRange from TimeRangeContext (hourly minimum for HourlyStats table).
 */
export function useSummary(options: UseSummaryOptions = {}) {
  const { comparePrevious = true, enabled = true } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()

  // Use statsRange (hourly minimum) for summary stats queries
  const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
  const params: SummaryParams = {
    startDate,
    endDate,
    comparePrevious,
  }

  return useQuery({
    // Query key uses statsRange + lastRefresh for stability
    queryKey: queryKeys.analytics.summary({ range, customRange, comparePrevious }, lastRefresh),
    queryFn: () => fetchSummary(params),
    enabled,
    staleTime: 15 * 1000, // 15 seconds
    refetchInterval: pollInterval || false,
  })
}

/**
 * Fetch live summary statistics for the dashboard.
 * Uses timeRange from TimeRangeContext (can be more granular).
 */
export function useLiveSummary(options: UseSummaryOptions = {}) {
  const { comparePrevious = true, enabled = true } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()

  // Use range (can be more granular) for live summary stats queries
  const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
  const params: SummaryParams = {
    startDate,
    endDate,
    comparePrevious,
  }

  return useQuery({
    // Query key uses range + lastRefresh for stability
    queryKey: queryKeys.analytics.liveSummary({ range, customRange, comparePrevious }, lastRefresh),
    queryFn: () => fetchLiveSummary(params),
    enabled,
    staleTime: 15 * 1000, // 15 seconds
    refetchInterval: pollInterval || false,
  })
}

export interface UseTimeSeriesOptions {
  /** Override granularity (default: auto based on range) */
  granularity?: "hourly" | "daily"
  /** Enable/disable the query */
  enabled?: boolean
}


export interface UseGeoJSONOptions {
  /** Enable/disable the query */
  enabled?: boolean
  /** Filter to these ISO country codes */
  countryCodes?: string[]
  /** Filter to these city names */
  cities?: string[]
  /** Filter to these source hostnames */
  hostnames?: string[]
}

/**
 * Fetch GeoJSON data for map visualization.
 * Uses TimeRangeContext for time filtering.
 */
export function useGeoJSON(options: UseGeoJSONOptions = {}) {
  const { enabled = true, countryCodes, cities, hostnames } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()

  return useQuery({
    // Query key uses lastRefresh for cache invalidation on manual refresh
    queryKey: queryKeys.geo.geojson(
      { range, customRange, countryCodes, cities, hostnames },
      lastRefresh,
    ),
    // Compute date range at fetch time so polls get fresh data
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchGeoJSON({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        countryCodes,
        cities,
        hostnames,
      })
    },
    enabled,
    staleTime: 60 * 1000, // Geo data changes less frequently
    refetchInterval: pollInterval || false,
  })
}

export interface UseGlobalTopIPsOptions {
  /** Enable/disable the query */
  enabled?: boolean
  /** Maximum number of IPs to return */
  limit?: number
}

/**
 * Fetch global top IPs by event count.
 * Uses TimeRangeContext for time filtering.
 */
export function useGlobalTopIPs(options: UseGlobalTopIPsOptions = {}) {
  const { enabled = true, limit = 5 } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()

  return useQuery<GlobalTopIPsResponse>({
    queryKey: queryKeys.geo.globalTopIPs({ range, customRange, limit }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchGlobalTopIPs({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        limit,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

export interface UseLocationTopIPsOptions {
  /** Enable/disable the query */
  enabled?: boolean
  /** Maximum number of IPs to return */
  limit?: number
}

/**
 * Fetch top IPs for a specific location.
 * Uses TimeRangeContext for time filtering.
 */
export function useLocationTopIPs(locationId: number | null, options: UseLocationTopIPsOptions = {}) {
  const { enabled = true, limit = 5 } = options
  const { range, customRange, lastRefresh } = useTimeRange()

  return useQuery<LocationTopIPsResponse>({
    queryKey: queryKeys.geo.locationTopIPs(locationId ?? 0, { range, customRange, limit }, lastRefresh),
    queryFn: () => {
      if (locationId === null) {
        throw new Error("locationId is required")
      }
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchLocationTopIPs({
        locationId,
        fromTimestamp: startDate,
        toTimestamp: endDate,
        limit,
      })
    },
    enabled: enabled && locationId !== null,
    staleTime: 60 * 1000,
    // No polling for location-specific data (on-demand only)
  })
}

export interface UseTopCountriesOptions {
  /** Enable/disable the query */
  enabled?: boolean
  /** Maximum number of countries to return */
  limit?: number
}

/**
 * Fetch top countries by event count.
 * Uses TimeRangeContext for time filtering.
 */
export function useTopCountries(options: UseTopCountriesOptions = {}) {
  const { enabled = true, limit = 10 } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()

  return useQuery<TopCountriesResponse>({
    queryKey: queryKeys.geo.topCountries({ range, customRange, limit }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchTopCountries({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        limit,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

export interface UseCumulativeTimeSeriesOptions {
  /** Enable/disable the query */
  enabled?: boolean
}

/**
 * Fetch cumulative time series data for area charts.
 * Uses TimeRangeContext for time filtering.
 */
export function useCumulativeTimeSeries(options: UseCumulativeTimeSeriesOptions = {}) {
  const { enabled = true } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()

  return useQuery<CumulativeTimeSeriesResponse>({
    queryKey: queryKeys.analytics.cumulativeTimeSeries({ range, customRange }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchCumulativeTimeSeries({
        startDate,
        endDate,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

// ============================================================================
// Analytics page hooks (generated-SDK fetchers; types infer from the fetcher
// so the generated shapes — percentiles, unique_cities — flow to the charts)
// ============================================================================

export interface UseAnalyticsQueryOptions {
  /** Enable/disable the query */
  enabled?: boolean
}

export interface UseTopListOptions extends UseAnalyticsQueryOptions {
  /** Maximum number of rows to return */
  limit?: number
}

/**
 * Fetch per-bucket access-log metrics (requests, status, bytes, latency).
 * Uses TimeRangeContext for time filtering.
 */
export function useTimeSeries(options: UseAnalyticsQueryOptions = {}) {
  const { enabled = true } = options
  const { range, customRange, granularity, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useAnalyticsFilters()
  const resolved = resolveChartGranularity(granularity, range, customRange)

  return useQuery({
    queryKey: queryKeys.analytics.timeSeries({ range, customRange, granularity: resolved, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchTimeSeries({
        startDate,
        endDate,
        granularity: resolved,
        countryCodes: filters.countryCodes,
        cities: filters.cities,
        ips: filters.ips,
        ipsExclude: filters.ipsExclude,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * Fetch per-bucket geo-event metrics (events, unique IPs/countries/cities).
 * Uses TimeRangeContext for time filtering.
 */
export function useGeoTimeSeries(options: UseAnalyticsQueryOptions = {}) {
  const { enabled = true } = options
  const { range, customRange, granularity, pollInterval, lastRefresh } = useTimeRange()
  const resolved = resolveChartGranularity(granularity, range, customRange)

  return useQuery({
    queryKey: queryKeys.analytics.geoTimeSeries({ range, customRange, granularity: resolved }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchGeoTimeSeries({ startDate, endDate, granularity: resolved })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * Fetch the top URLs by hit count.
 * Uses TimeRangeContext for time filtering.
 */
export function useTopUrls(options: UseTopListOptions = {}) {
  const { enabled = true, limit = 25 } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useAnalyticsFilters()

  return useQuery({
    queryKey: queryKeys.analytics.topUrls({ range, customRange, limit, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchTopUrls({
        startDate,
        endDate,
        limit,
        countryCodes: filters.countryCodes,
        cities: filters.cities,
        ips: filters.ips,
        ipsExclude: filters.ipsExclude,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * Fetch the top user agents by hit count.
 * Uses TimeRangeContext for time filtering.
 */
export function useTopUserAgents(options: UseTopListOptions = {}) {
  const { enabled = true, limit = 25 } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useAnalyticsFilters()

  return useQuery({
    queryKey: queryKeys.analytics.topUserAgents({ range, customRange, limit, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchTopUserAgents({
        startDate,
        endDate,
        limit,
        countryCodes: filters.countryCodes,
        cities: filters.cities,
        ips: filters.ips,
        ipsExclude: filters.ipsExclude,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * Fetch the top ASNs plus hosting-vs-other category totals.
 * Uses TimeRangeContext for time filtering.
 */
export function useTopAsns(options: UseTopListOptions = {}) {
  const { enabled = true, limit = 25 } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useAnalyticsFilters()

  return useQuery({
    queryKey: queryKeys.analytics.topAsns({ range, customRange, limit, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchTopAsns({
        startDate,
        endDate,
        limit,
        countryCodes: filters.countryCodes,
        cities: filters.cities,
        ips: filters.ips,
        ipsExclude: filters.ipsExclude,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * Fetch the top client IPs by hit count.
 * Uses TimeRangeContext for time filtering.
 */
export function useTopIpStats(options: UseTopListOptions = {}) {
  const { enabled = true, limit = 25 } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useAnalyticsFilters()

  return useQuery({
    queryKey: queryKeys.analytics.topIps({ range, customRange, limit, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchTopIpStats({
        startDate,
        endDate,
        limit,
        countryCodes: filters.countryCodes,
        cities: filters.cities,
        ips: filters.ips,
        ipsExclude: filters.ipsExclude,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * Fetch the top countries by hit count.
 * Uses TimeRangeContext for time filtering.
 */
export function useTopCountryStats(options: UseTopListOptions = {}) {
  const { enabled = true, limit = 25 } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useAnalyticsFilters()

  return useQuery({
    queryKey: queryKeys.analytics.topCountryStats({ range, customRange, limit, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchTopCountryStats({
        startDate,
        endDate,
        limit,
        countryCodes: filters.countryCodes,
        cities: filters.cities,
        ips: filters.ips,
        ipsExclude: filters.ipsExclude,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * Fetch the top cities by hit count.
 * Uses TimeRangeContext for time filtering.
 */
export function useTopCityStats(options: UseTopListOptions = {}) {
  const { enabled = true, limit = 25 } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useAnalyticsFilters()

  return useQuery({
    queryKey: queryKeys.analytics.topCityStats({ range, customRange, limit, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchTopCityStats({
        startDate,
        endDate,
        limit,
        countryCodes: filters.countryCodes,
        cities: filters.cities,
        ips: filters.ips,
        ipsExclude: filters.ipsExclude,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

// ============================================================================
// Access logs
// ============================================================================

export interface UseAccessLogsOptions {
  currentPage?: number
  pageSize?: number
  enabled?: boolean
  searchString?: string
  ipAddressIn?: string[]
  ipAddressNotIn?: string[]
  methodIn?: string[]
  hostIn?: string[]
  hostNotIn?: string[]
  hostnameIn?: string[]
  hostnameNotIn?: string[]
  logFormatIn?: string[]
  cityIn?: string[]
  countryCodeIn?: string[]
  statusIn?: number[]
  sortField?: AccessLogSortField
  sortOrder?: SortOrder
}

/**
 * Fetch a page of historical access logs within the global time range.
 * Server-side pagination; keeps the previous page visible while the next loads.
 */
export function useAccessLogs(options: UseAccessLogsOptions = {}) {
  const {
    currentPage = 1,
    pageSize = 50,
    enabled = true,
    searchString,
    ipAddressIn,
    ipAddressNotIn,
    methodIn,
    hostIn,
    hostNotIn,
    hostnameIn,
    hostnameNotIn,
    logFormatIn,
    cityIn,
    countryCodeIn,
    statusIn,
    sortField,
    sortOrder,
  } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()

  return useQuery<AccessLogsPage>({
    queryKey: queryKeys.accessLogs.list(
      { range, customRange, currentPage, pageSize, searchString, ipAddressIn, ipAddressNotIn, methodIn, hostIn, hostNotIn, hostnameIn, hostnameNotIn, logFormatIn, cityIn, countryCodeIn, statusIn, sortField, sortOrder },
      lastRefresh,
    ),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchAccessLogs({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        currentPage,
        pageSize,
        searchString,
        ipAddressIn,
        ipAddressNotIn,
        methodIn,
        hostIn,
        hostNotIn,
        hostnameIn,
        hostnameNotIn,
        logFormatIn,
        cityIn,
        countryCodeIn,
        statusIn,
        sortField,
        sortOrder,
      })
    },
    enabled,
    placeholderData: (prev) => prev, // v5 keepPreviousData: no blank flash while paging
    staleTime: 15 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * Distinct country/city filter options. Fetched lazily (enable on first
 * dropdown open); staleTime keeps reopen-refetches to at most one per minute.
 */
export function useAccessLogFacets({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<AccessLogFacets>({
    queryKey: queryKeys.accessLogs.facets(),
    queryFn: fetchAccessLogFacets,
    enabled,
    staleTime: 60 * 1000,
  })
}

// ============================================================================
// Access log debug
// ============================================================================

export interface UseAccessLogDebugOptions {
  currentPage?: number
  pageSize?: number
  enabled?: boolean
  searchString?: string
  ipAddressIn?: string[]
  countryCodeIn?: string[]
  cityIn?: string[]
  /** true = malformed only, false = well-formed only, undefined = all. */
  malformed?: boolean
  sortField?: AccessLogDebugSortField
  sortOrder?: SortOrder
}

/**
 * Fetch a page of debug lines within the global time range.
 * Server-side pagination; keeps the previous page visible while the next loads.
 */
export function useAccessLogDebug(options: UseAccessLogDebugOptions = {}) {
  const {
    currentPage = 1,
    pageSize = 50,
    enabled = true,
    searchString,
    ipAddressIn,
    countryCodeIn,
    cityIn,
    malformed,
    sortField,
    sortOrder,
  } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()

  return useQuery<AccessLogDebugPage>({
    queryKey: queryKeys.accessLogDebug.list(
      { range, customRange, currentPage, pageSize, searchString, ipAddressIn, countryCodeIn, cityIn, malformed, sortField, sortOrder },
      lastRefresh,
    ),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchAccessLogDebug({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        currentPage,
        pageSize,
        searchString,
        ipAddressIn,
        countryCodeIn,
        cityIn,
        malformed,
        sortField,
        sortOrder,
      })
    },
    enabled,
    placeholderData: (prev) => prev,
    staleTime: 15 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/** Aggregate debug-line stats for the stat cards, within the global time range. */
export function useAccessLogDebugStats() {
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()

  return useQuery<AccessLogDebugStats>({
    queryKey: queryKeys.accessLogDebug.stats({ range, customRange }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchAccessLogDebugStats({ fromTimestamp: startDate, toTimestamp: endDate })
    },
    staleTime: 15 * 1000,
    refetchInterval: pollInterval || false,
  })
}

// ============================================================================
// Geo logs page (generated-SDK fetchers; every hook threads the full filter
// set from GeoLogFiltersContext so map/stats/chart/top-10s/table move together)
// ============================================================================

export interface UseGeoLogsOptions {
  currentPage?: number
  pageSize?: number
  sortField?: GeoLogSortField
  sortOrder?: GeoLogSortOrder
  enabled?: boolean
}

/**
 * Grouped (location, IP) rows with counts for the geo-logs table.
 * Server-side pagination; keeps the previous page visible while the next loads.
 */
export function useGeoLogs(options: UseGeoLogsOptions = {}) {
  const { currentPage = 1, pageSize = 50, sortField = "eventCount", sortOrder = "desc", enabled = true } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useGeoLogFilters()

  return useQuery({
    queryKey: queryKeys.geoLogs.list(
      { range, customRange, currentPage, pageSize, sortField, sortOrder, filters },
      lastRefresh,
    ),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchGeoLogs({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        currentPage,
        pageSize,
        sortField,
        sortOrder,
        ...filters,
      })
    },
    enabled,
    placeholderData: (prev) => prev, // v5 keepPreviousData: no blank flash while paging
    staleTime: 15 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/** Aggregate totals/uniques for the geo-logs stat cards. */
export function useGeoLogSummary(options: { comparePrevious?: boolean; enabled?: boolean } = {}) {
  const { comparePrevious = true, enabled = true } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useGeoLogFilters()

  return useQuery({
    queryKey: queryKeys.geoLogs.summary({ range, customRange, comparePrevious, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchGeoLogSummary({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        comparePrevious,
        ...filters,
      })
    },
    enabled,
    staleTime: 15 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/** Bucketed geo-event totals + unique IPs for the geo-logs chart. */
export function useGeoLogTimeSeries(options: UseAnalyticsQueryOptions = {}) {
  const { enabled = true } = options
  const { range, customRange, granularity, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useGeoLogFilters()
  const resolved = resolveChartGranularity(granularity, range, customRange)

  return useQuery({
    queryKey: queryKeys.geoLogs.timeSeries({ range, customRange, granularity: resolved, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchGeoLogTimeSeries({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        granularity: resolved,
        ...filters,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/** Top IPs by geo-event count (across all locations). */
export function useGeoLogTopIps(options: UseTopListOptions = {}) {
  const { enabled = true, limit = 10 } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useGeoLogFilters()

  return useQuery({
    queryKey: queryKeys.geoLogs.topIps({ range, customRange, limit, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchGeoLogTopIps({ fromTimestamp: startDate, toTimestamp: endDate, limit, ...filters })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/** Top countries by geo-event count with exact unique-IP counts. */
export function useGeoLogTopCountries(options: UseTopListOptions = {}) {
  const { enabled = true, limit = 10 } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useGeoLogFilters()

  return useQuery({
    queryKey: queryKeys.geoLogs.topCountries({ range, customRange, limit, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchGeoLogTopCountries({ fromTimestamp: startDate, toTimestamp: endDate, limit, ...filters })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/** Top cities by geo-event count (NULL cities excluded). */
export function useGeoLogTopCities(options: UseTopListOptions = {}) {
  const { enabled = true, limit = 10 } = options
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useGeoLogFilters()

  return useQuery({
    queryKey: queryKeys.geoLogs.topCities({ range, customRange, limit, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchGeoLogTopCities({ fromTimestamp: startDate, toTimestamp: endDate, limit, ...filters })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * GeoJSON for the embedded geo-logs map: same endpoint as the map page but
 * threaded through the full geo-logs filter set (incl. IP exclude/hostname).
 */
export function useGeoLogsGeoJSON({ enabled = true }: { enabled?: boolean } = {}) {
  const { range, customRange, pollInterval, lastRefresh } = useTimeRange()
  const { filters } = useGeoLogFilters()

  return useQuery({
    queryKey: queryKeys.geoLogs.geojson({ range, customRange, filters }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchGeoJSON({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        ...filters,
      })
    },
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * Distinct country/city/hostname filter options. Fetched lazily (enable on
 * first dropdown open); staleTime keeps reopen-refetches to one per minute.
 */
export function useGeoEventFacets({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.geoLogs.facets(),
    queryFn: fetchGeoEventFacets,
    enabled,
    staleTime: 60 * 1000,
  })
}

/** Per-source home locations for the map; homes change rarely. */
export function useSiteHomes() {
  return useQuery({
    queryKey: queryKeys.geo.siteHomes,
    queryFn: fetchSiteHomes,
    staleTime: 5 * 60 * 1000,
  })
}

/** Removes a retired source's auto home; the map's home resolver rebuilds
 *  from the refetched list. */
export function useDeleteSiteHome() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (hostname: string) => deleteSiteHome(hostname),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.geo.siteHomes }),
  })
}

// ============================================================================
// Logs
// ============================================================================

/**
 * Initial page of recent structured log records for the Logs page.
 * The live stream (logStream) takes over after this loads, so it never refetches.
 */
export function useLogTail(lines = 500, source: "app" | "login" = "app") {
  return useQuery({
    queryKey: queryKeys.logs.tail(lines, source),
    queryFn: async () => {
      const { data } = await apiV1LogsTailTail({
        query: { lines, source },
        throwOnError: true,
      })
      return data.records
    },
    staleTime: Number.POSITIVE_INFINITY, // stream takes over after initial load
  })
}

/** Recent app-log records for the Status page error panel. Raw records;
 *  error filtering lives in status-logic so it stays unit-testable. */
export function useRecentErrors() {
  return useQuery({
    queryKey: ["logs", "recent-errors"],
    queryFn: async () => {
      const { data } = await apiV1LogsTailTail({
        query: { lines: 300, source: "app" },
        throwOnError: true,
      })
      return data.records as LogRecord[]
    },
    refetchInterval: 15_000,
  })
}

/** Available log files (app/login/access) for the Logs page file picker. */
export function useLogFiles() {
  return useQuery({
    queryKey: queryKeys.logs.files,
    queryFn: async () => {
      const { data } = await apiV1LogsFilesListFiles({
        throwOnError: true,
      })
      return data.files
    },
    refetchInterval: 30_000,
  })
}

// ---- IP inspector ---------------------------------------------------------

export function useIpProfile(ip: string | undefined) {
  const { range, customRange, lastRefresh } = useTimeRange()
  return useQuery({
    queryKey: queryKeys.analytics.ipProfile({ range, customRange, ip }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchIpProfile({ startDate, endDate, ip: ip! })
    },
    enabled: Boolean(ip),
    staleTime: 60 * 1000,
  })
}

/** Every location this IP resolved to in range; geo-logs is already
 *  grouped by (location, IP), so one page with the IP filter is the list. */
export function useIpLocations(ip: string | undefined) {
  const { range, customRange, lastRefresh } = useTimeRange()
  return useQuery({
    queryKey: queryKeys.ipInspector.locations({ range, customRange, ip }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchGeoLogs({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        ips: [ip!],
        pageSize: 50,
        sortField: "eventCount",
        sortOrder: "desc",
      })
    },
    enabled: Boolean(ip),
    staleTime: 60 * 1000,
  })
}

export function useIpDecisions(ip: string | undefined) {
  const { data: status } = useCrowdsecStatus()
  const { lastRefresh } = useTimeRange()
  return useQuery({
    queryKey: queryKeys.crowdsec.lookup(ip ?? "", lastRefresh),
    queryFn: () => fetchCrowdsecDecisionLookup(ip!),
    enabled: Boolean(ip) && status?.enabled === true,
    staleTime: 30 * 1000,
  })
}

/** Newest alert for the IP; its createdAt is the ban start. Alerts need
 *  machine credentials, hence the writeEnabled gate. */
export function useIpLatestAlert(ip: string | undefined) {
  const { data: status } = useCrowdsecStatus()
  const { lastRefresh } = useTimeRange()
  return useQuery({
    queryKey: queryKeys.crowdsec.latestAlert(ip ?? "", lastRefresh),
    queryFn: () => fetchCrowdsecAlerts({ ip: ip!, limit: 1 }),
    enabled: Boolean(ip) && status?.writeEnabled === true,
    staleTime: 30 * 1000,
    select: (alerts) => alerts[0] ?? null,
  })
}

export function useIpLatestRequests(ip: string | undefined) {
  const { range, customRange, lastRefresh } = useTimeRange()
  return useQuery({
    queryKey: queryKeys.ipInspector.latestRequests({ range, customRange, ip }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
      return fetchAccessLogs({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        ipAddressIn: [ip!],
        pageSize: 10,
        sortField: "timestamp",
        sortOrder: "desc",
      })
    },
    enabled: Boolean(ip),
    staleTime: 30 * 1000,
  })
}
