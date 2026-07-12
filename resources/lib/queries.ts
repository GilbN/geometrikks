/**
 * TanStack Query hooks for GeoMetrikks API.
 */

import { useQuery } from "@tanstack/react-query"
import {
  fetchSummary,
  fetchLiveSummary,
  fetchGeoJSON,
  fetchGeoTimeSeries,
  fetchGlobalTopIPs,
  fetchLocationTopIPs,
  fetchTimeSeries,
  fetchTopCountries,
  fetchTopUrls,
  fetchTopUserAgents,
  fetchCumulativeTimeSeries,
  fetchAccessLogs,
  parseTimeRange,
  type SummaryParams,
  type GlobalTopIPsResponse,
  type LocationTopIPsResponse,
  type TopCountriesResponse,
  type CumulativeTimeSeriesResponse,
  type AccessLogsPage,
} from "./api"
import { useTimeRange } from "./time-range-context"

// ============================================================================
// Query Keys
// ============================================================================

export const queryKeys = {
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
  },
  accessLogs: {
    all: ["access-logs"] as const,
    list: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.accessLogs.all, "list", params, refreshKey] as const,
  },
}

// ============================================================================
// Hooks
// ============================================================================

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
  const { range, pollInterval, lastRefresh } = useTimeRange()

  // Use statsRange (hourly minimum) for summary stats queries
  const { startDate, endDate } = parseTimeRange(range, Date.now())
  const params: SummaryParams = {
    startDate,
    endDate,
    comparePrevious,
  }

  return useQuery({
    // Query key uses statsRange + lastRefresh for stability
    queryKey: queryKeys.analytics.summary({ range, comparePrevious }, lastRefresh),
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
  const { range, pollInterval, lastRefresh } = useTimeRange()

  // Use range (can be more granular) for live summary stats queries
  const { startDate, endDate } = parseTimeRange(range, Date.now())
  const params: SummaryParams = {
    startDate,
    endDate,
    comparePrevious,
  }

  return useQuery({
    // Query key uses range + lastRefresh for stability
    queryKey: queryKeys.analytics.liveSummary({ range, comparePrevious }, lastRefresh),
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
}

/**
 * Fetch GeoJSON data for map visualization.
 * Uses TimeRangeContext for time filtering.
 */
export function useGeoJSON(options: UseGeoJSONOptions = {}) {
  const { enabled = true, countryCodes, cities } = options
  const { range, pollInterval, lastRefresh } = useTimeRange()

  return useQuery({
    // Query key uses lastRefresh for cache invalidation on manual refresh
    queryKey: queryKeys.geo.geojson({ range, countryCodes, cities }, lastRefresh),
    // Compute date range at fetch time so polls get fresh data
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now())
      return fetchGeoJSON({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        countryCodes,
        cities,
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
  const { range, pollInterval, lastRefresh } = useTimeRange()

  return useQuery<GlobalTopIPsResponse>({
    queryKey: queryKeys.geo.globalTopIPs({ range, limit }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now())
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
  const { range, lastRefresh } = useTimeRange()

  return useQuery<LocationTopIPsResponse>({
    queryKey: queryKeys.geo.locationTopIPs(locationId ?? 0, { range, limit }, lastRefresh),
    queryFn: () => {
      if (locationId === null) {
        throw new Error("locationId is required")
      }
      const { startDate, endDate } = parseTimeRange(range, Date.now())
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
  const { range, pollInterval, lastRefresh } = useTimeRange()

  return useQuery<TopCountriesResponse>({
    queryKey: queryKeys.geo.topCountries({ range, limit }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now())
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
  const { range, pollInterval, lastRefresh } = useTimeRange()

  return useQuery<CumulativeTimeSeriesResponse>({
    queryKey: queryKeys.analytics.cumulativeTimeSeries({ range }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now())
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
  const { range, pollInterval, lastRefresh } = useTimeRange()

  return useQuery({
    queryKey: queryKeys.analytics.timeSeries({ range }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now())
      return fetchTimeSeries({ startDate, endDate })
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
  const { range, pollInterval, lastRefresh } = useTimeRange()

  return useQuery({
    queryKey: queryKeys.analytics.geoTimeSeries({ range }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now())
      return fetchGeoTimeSeries({ startDate, endDate })
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
  const { range, pollInterval, lastRefresh } = useTimeRange()

  return useQuery({
    queryKey: queryKeys.analytics.topUrls({ range, limit }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now())
      return fetchTopUrls({ startDate, endDate, limit })
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
  const { range, pollInterval, lastRefresh } = useTimeRange()

  return useQuery({
    queryKey: queryKeys.analytics.topUserAgents({ range, limit }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now())
      return fetchTopUserAgents({ startDate, endDate, limit })
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
}

/**
 * Fetch a page of historical access logs within the global time range.
 * Server-side pagination; keeps the previous page visible while the next loads.
 */
export function useAccessLogs(options: UseAccessLogsOptions = {}) {
  const { currentPage = 1, pageSize = 50, enabled = true } = options
  const { range, pollInterval, lastRefresh } = useTimeRange()

  return useQuery<AccessLogsPage>({
    queryKey: queryKeys.accessLogs.list({ range, currentPage, pageSize }, lastRefresh),
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now())
      return fetchAccessLogs({
        fromTimestamp: startDate,
        toTimestamp: endDate,
        currentPage,
        pageSize,
      })
    },
    enabled,
    placeholderData: (prev) => prev, // v5 keepPreviousData: no blank flash while paging
    staleTime: 15 * 1000,
    refetchInterval: pollInterval || false,
  })
}
