/**
 * TanStack Query hooks for GeoMetrikks API.
 */

import { useQuery } from "@tanstack/react-query"
import {
  fetchSummary,
  fetchLiveSummary,
  fetchGeoJSON,
  fetchGlobalTopIPs,
  fetchLocationTopIPs,
  parseTimeRange,
  parseStatsTimeRange,
  getGranularityForRange,
  type SummaryParams,
  type TimeSeriesParams,
  type GlobalTopIPsResponse,
  type LocationTopIPsResponse,
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
  },
  geo: {
    all: ["geo"] as const,
    geojson: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geo.all, "geojson", params, refreshKey] as const,
    globalTopIPs: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geo.all, "global-top-ips", params, refreshKey] as const,
    locationTopIPs: (locationId: number, params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geo.all, "location-top-ips", locationId, params, refreshKey] as const,
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
}

/**
 * Fetch GeoJSON data for map visualization.
 * Uses TimeRangeContext for time filtering.
 */
export function useGeoJSON(options: UseGeoJSONOptions = {}) {
  const { enabled = true } = options
  const { range, pollInterval, lastRefresh } = useTimeRange()

  return useQuery({
    // Query key uses lastRefresh for cache invalidation on manual refresh
    queryKey: queryKeys.geo.geojson({ range }, lastRefresh),
    // Compute date range at fetch time so polls get fresh data
    queryFn: () => {
      const { startDate, endDate } = parseTimeRange(range, Date.now())
      return fetchGeoJSON({
        fromTimestamp: startDate,
        toTimestamp: endDate,
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
