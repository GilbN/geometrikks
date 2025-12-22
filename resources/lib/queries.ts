/**
 * TanStack Query hooks for GeoMetrikks API.
 */

import { useQuery } from "@tanstack/react-query"
import {
  fetchSummary,
  fetchRequestsTimeSeries,
  fetchPerformanceTimeSeries,
  fetchGeoEventsTimeSeries,
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
    requestsTimeSeries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "requests-time-series", params, refreshKey] as const,
    performanceTimeSeries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "performance-time-series", params, refreshKey] as const,
    geoEventsTimeSeries: (params: Record<string, unknown>, refreshKey?: number) =>
      [...queryKeys.analytics.all, "geo-events-time-series", params, refreshKey] as const,
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
