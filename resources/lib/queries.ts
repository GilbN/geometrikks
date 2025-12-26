/**
 * TanStack Query hooks for GeoMetrikks API.
 */

import { useQuery } from "@tanstack/react-query"
import {
  fetchSummary,
  fetchLiveSummary,
  fetchRequestsTimeSeries,
  fetchPerformanceTimeSeries,
  fetchGeoEventsTimeSeries,
  fetchGeoJSON,
  parseTimeRange,
  parseStatsTimeRange,
  getGranularityForRange,
  type SummaryParams,
  type TimeSeriesParams,

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
    requestsTimeSeries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "requests-time-series", params, refreshKey] as const,
    performanceTimeSeries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "performance-time-series", params, refreshKey] as const,
    geoEventsTimeSeries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "geo-events-time-series", params, refreshKey] as const,
  },
  geo: {
    all: ["geo"] as const,
    geojson: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.geo.all, "geojson", params, refreshKey] as const,
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
  const { statsRange, pollInterval, lastRefresh } = useTimeRange()

  // Use statsRange (hourly minimum) for summary stats queries
  const { startDate, endDate } = parseStatsTimeRange(statsRange, lastRefresh)
  const params: SummaryParams = {
    startDate,
    endDate,
    comparePrevious,
  }

  return useQuery({
    // Query key uses statsRange + lastRefresh for stability
    queryKey: queryKeys.analytics.summary({ statsRange, comparePrevious }, lastRefresh),
    queryFn: () => fetchSummary(params),
    enabled,
    staleTime: 30 * 1000, // 30 seconds
    refetchInterval: pollInterval || false, // 0 = disabled
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

/**
 * Fetch requests time-series data for charts.
 * Uses TimeRangeContext for time range and poll interval.
 */
export function useRequestsTimeSeries(options: UseTimeSeriesOptions = {}) {
  const { granularity: granularityOverride, enabled = true } = options
  const { range, pollInterval, lastRefresh } = useTimeRange()

  // Use lastRefresh as reference time for stable query keys
  const { startDate, endDate } = parseTimeRange(range, lastRefresh)
  const granularity = granularityOverride ?? getGranularityForRange(range)
  const params: TimeSeriesParams = {
    startDate,
    endDate,
    granularity,
  }

  return useQuery({
    queryKey: queryKeys.analytics.requestsTimeSeries({ range, granularity }, lastRefresh),
    queryFn: () => fetchRequestsTimeSeries(params),
    enabled,
    staleTime: 30 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * Fetch performance time-series data for charts.
 * Uses TimeRangeContext for time range and poll interval.
 */
export function usePerformanceTimeSeries(options: UseTimeSeriesOptions = {}) {
  const { granularity: granularityOverride, enabled = true } = options
  const { range, pollInterval, lastRefresh } = useTimeRange()

  // Use lastRefresh as reference time for stable query keys
  const { startDate, endDate } = parseTimeRange(range, lastRefresh)
  const granularity = granularityOverride ?? getGranularityForRange(range)
  const params: TimeSeriesParams = {
    startDate,
    endDate,
    granularity,
  }

  return useQuery({
    queryKey: queryKeys.analytics.performanceTimeSeries({ range, granularity }, lastRefresh),
    queryFn: () => fetchPerformanceTimeSeries(params),
    enabled,
    staleTime: 30 * 1000,
    refetchInterval: pollInterval || false,
  })
}

/**
 * Fetch geo events time-series data for charts.
 * Uses TimeRangeContext for time range and poll interval.
 */
export function useGeoEventsTimeSeries(options: UseTimeSeriesOptions = {}) {
  const { granularity: granularityOverride, enabled = true } = options
  const { range, pollInterval, lastRefresh } = useTimeRange()

  // Use lastRefresh as reference time for stable query keys
  const { startDate, endDate } = parseTimeRange(range, lastRefresh)
  const granularity = granularityOverride ?? getGranularityForRange(range)
  const params: TimeSeriesParams = {
    startDate,
    endDate,
    granularity,
  }

  return useQuery({
    queryKey: queryKeys.analytics.geoEventsTimeSeries({ range, granularity }, lastRefresh),
    queryFn: () => fetchGeoEventsTimeSeries(params),
    enabled,
    staleTime: 30 * 1000,
    refetchInterval: pollInterval || false,
  })
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
