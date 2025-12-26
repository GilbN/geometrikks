/**
 * API client and types for GeoMetrikks backend.
 */

import axios from "axios"

// Create axios instance with base configuration
export const api = axios.create({
  baseURL: "/api/v1",
  headers: {
    "Content-Type": "application/json",
  },
})

// ============================================================================
// Types - Analytics API
// ============================================================================

export interface PeriodSummary {
  total_requests: number
  total_geo_events: number
  unique_ips: number
  unique_countries: number
  total_bytes_sent: number
  avg_bytes_per_request: number
  status_2xx: number
  status_3xx: number
  status_4xx: number
  status_5xx: number
  avg_request_time: number
  max_request_time: number
  malformed_requests: number
  error_rate: number
}

export interface PercentChange {
  requests: number | null
  geo_events: number | null
  unique_ips: number | null
  bytes_sent: number | null
  avg_request_time: number | null
  error_rate: number | null
}

export interface SummaryResponse {
  start_date: string
  end_date: string
  current_period: PeriodSummary
  previous_period: PeriodSummary | null
  percent_changes: PercentChange | null
}

export interface TimeSeriesDataPoint {
  timestamp: string
  total_requests: number
  total_geo_events: number
  total_bytes_sent: number
  status_2xx: number
  status_3xx: number
  status_4xx: number
  status_5xx: number
  error_rate: number
}

export interface TimeSeriesResponse {
  granularity: "hourly" | "daily"
  start_date: string
  end_date: string
  data: TimeSeriesDataPoint[]
}

export interface PerformanceDataPoint {
  timestamp: string
  avg_request_time: number
  max_request_time: number
}

export interface PerformanceTimeSeriesResponse {
  granularity: "hourly" | "daily"
  start_date: string
  end_date: string
  data: PerformanceDataPoint[]
}

export interface GeoEventsDataPoint {
  timestamp: string
  total_geo_events: number
  unique_ips: number
  unique_countries: number
}

export interface GeoEventsTimeSeriesResponse {
  granularity: "hourly" | "daily"
  start_date: string
  end_date: string
  data: GeoEventsDataPoint[]
}

// ============================================================================
// Types - GeoJSON API
// ============================================================================

export interface GeoJSONFeatureProperties {
  id: number
  geohash: string
  country_code: string | null
  country_name: string | null
  state: string | null
  state_code: string | null
  city: string | null
  postal_code: string | null
  timezone: string | null
  event_count: number
  last_hit: string | null
}

export interface GeoJSONPointGeometry {
  type: "Point"
  coordinates: [number, number] // [longitude, latitude]
}

export interface GeoJSONFeature {
  type: "Feature"
  geometry: GeoJSONPointGeometry
  properties: GeoJSONFeatureProperties
}

export interface GeoJSONFeatureCollection {
  type: "FeatureCollection"
  features: GeoJSONFeature[]
  event_count: number
}

// ============================================================================
// API Functions
// ============================================================================

export interface SummaryParams {
  startDate: string // ISO date string (YYYY-MM-DD)
  endDate: string
  comparePrevious?: boolean
}

export async function fetchSummary(params: SummaryParams): Promise<SummaryResponse> {
  const { data } = await api.get<SummaryResponse>("/analytics/summary", {
    params: {
      start_date: params.startDate,
      end_date: params.endDate,
      compare_previous: params.comparePrevious ?? true,
    },
  })
  return data
}

export interface TimeSeriesParams {
  startDate: string
  endDate: string
  granularity?: "hourly" | "daily"
}

export async function fetchRequestsTimeSeries(
  params: TimeSeriesParams
): Promise<TimeSeriesResponse> {
  const { data } = await api.get<TimeSeriesResponse>("/analytics/time-series/requests", {
    params: {
      start_date: params.startDate,
      end_date: params.endDate,
      granularity: params.granularity ?? "daily",
    },
  })
  return data
}

export async function fetchPerformanceTimeSeries(
  params: TimeSeriesParams
): Promise<PerformanceTimeSeriesResponse> {
  const { data } = await api.get<PerformanceTimeSeriesResponse>(
    "/analytics/time-series/performance",
    {
      params: {
        start_date: params.startDate,
        end_date: params.endDate,
        granularity: params.granularity ?? "daily",
      },
    }
  )
  return data
}

export async function fetchGeoEventsTimeSeries(
  params: TimeSeriesParams
): Promise<GeoEventsTimeSeriesResponse> {
  const { data } = await api.get<GeoEventsTimeSeriesResponse>(
    "/analytics/time-series/geo-events",
    {
      params: {
        start_date: params.startDate,
        end_date: params.endDate,
        granularity: params.granularity ?? "daily",
      },
    }
  )
  return data
}

export interface GeoJSONParams {
  fromTimestamp: string // Full ISO timestamp
  toTimestamp: string
}

export async function fetchGeoJSON(params: GeoJSONParams): Promise<GeoJSONFeatureCollection> {
  const { data } = await api.get<GeoJSONFeatureCollection>("/geo-locations/geojson", {
    params: {
      from_timestamp: params.fromTimestamp,
      to_timestamp: params.toTimestamp,
    },
  })
  return data
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format a number with locale-aware thousand separators.
 */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

/**
 * Format bytes to human-readable string (KB, MB, GB).
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

/**
 * Format milliseconds to human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/**
 * Format percentage with sign.
 */
export function formatPercent(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—"
  const num = typeof value === "string" ? parseFloat(value) : value
  if (isNaN(num)) return "—"
  const sign = num >= 0 ? "+" : ""
  return `${sign}${num.toFixed(1)}%`
}

/**
 * Get ISO date string for N days ago (YYYY-MM-DD).
 */
export function getDateDaysAgo(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return date.toISOString().split("T")[0]
}

/**
 * Get full ISO timestamp for N minutes ago.
 */
export function getTimestampMinutesAgo(minutes: number): string {
  const date = new Date()
  date.setTime(date.getTime() - minutes * 60 * 1000)
  return date.toISOString()
}

/**
 * Get today's date string (YYYY-MM-DD).
 */
export function getTodayDate(): string {
  return new Date().toISOString().split("T")[0]
}

/**
 * Get current ISO timestamp.
 */
export function getNowTimestamp(): string {
  return new Date().toISOString()
}

// ============================================================================
// Time Range Types & Utilities
// ============================================================================

export type TimeRangeValue = "5m" | "15m" | "1h" | "24h" | "7d" | "30d" | "90d"

/** Stats-specific time range (hourly minimum for HourlyStats table compatibility) */
export type StatsTimeRangeValue = "1h" | "2h" | "3h" | "6h" | "12h" | "24h" | "7d" | "30d" | "90d"

export interface TimeRangePreset {
  label: string
  value: TimeRangeValue
  minutes: number
}

export interface StatsTimeRangePreset {
  label: string
  value: StatsTimeRangeValue
  minutes: number
  description: string
}

export const TIME_RANGE_PRESETS: TimeRangePreset[] = [
  { label: "5m", value: "5m", minutes: 5 },
  { label: "15m", value: "15m", minutes: 15 },
  { label: "1h", value: "1h", minutes: 60 },
  { label: "24h", value: "24h", minutes: 1440 },
  { label: "7d", value: "7d", minutes: 10080 },
  { label: "30d", value: "30d", minutes: 43200 },
  { label: "90d", value: "90d", minutes: 129600 },
]

/** Stats time range presets (hourly minimum for HourlyStats table) */
export const STATS_TIME_RANGE_PRESETS: StatsTimeRangePreset[] = [
  { label: "1h", value: "1h", minutes: 60, description: "Queries the last 1 complete hour bucket" },
  { label: "2h", value: "2h", minutes: 120, description: "Queries the last 2 complete hour buckets" },
  { label: "3h", value: "3h", minutes: 180, description: "Queries the last 3 complete hour buckets" },
  { label: "6h", value: "6h", minutes: 360, description: "Queries the last 6 complete hour buckets" },
  { label: "12h", value: "12h", minutes: 720, description: "Queries the last 12 complete hour buckets" },
  { label: "24h", value: "24h", minutes: 1440, description: "Queries the last 24 complete hour buckets" },
  { label: "7d", value: "7d", minutes: 10080, description: "Queries the last 7 days (168 hour buckets)" },
  { label: "30d", value: "30d", minutes: 43200, description: "Queries the last 30 days (720 hour buckets)" },
  { label: "90d", value: "90d", minutes: 129600, description: "Queries the last 90 days (2160 hour buckets)" },
]

export interface PollIntervalOption {
  label: string
  value: number // milliseconds, 0 = off
}

export const POLL_INTERVAL_OPTIONS: PollIntervalOption[] = [
  { label: "Off", value: 0 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
  { label: "30s", value: 30000 },
  { label: "1m", value: 60000 },
  { label: "5m", value: 300000 },
]

/**
 * Parse a time range value and return start/end ISO timestamps.
 * Always returns full ISO timestamps for backend compatibility.
 */
export function parseTimeRange(range: TimeRangeValue, referenceTime?: number): { startDate: string; endDate: string } {
  const preset = TIME_RANGE_PRESETS.find((p) => p.value === range)
  if (!preset) {
    // Default to 7 days if invalid range
    const now = referenceTime ? new Date(referenceTime) : new Date()
    const start = new Date(now)
    start.setDate(start.getDate() - 7)
    return { startDate: start.toISOString(), endDate: now.toISOString() }
  }

  // Use reference time for stable query keys (prevents infinite refetch)
  const now = referenceTime ? new Date(referenceTime) : new Date()
  const start = new Date(now.getTime() - preset.minutes * 60 * 1000)

  return {
    startDate: start.toISOString(),
    endDate: now.toISOString(),
  }
}

/**
 * Ceil a date to the next hour (e.g., 10:45 -> 11:00), or same if already at hour boundary.
 */
function ceilToHour(date: Date): Date {
  const result = new Date(date)
  if (result.getMinutes() === 0 && result.getSeconds() === 0 && result.getMilliseconds() === 0) {
    return result
  }
  result.setMinutes(0, 0, 0)
  result.setTime(result.getTime() + 60 * 60 * 1000)
  return result
}

/**
 * Parse a stats time range value and return start/end ISO timestamps.
 * For HourlyStats table queries (hourly minimum granularity).
 *
 * Timestamps are aligned to hour boundaries to match HourlyStats bucket precision:
 * - End is ceiled to the next hour (includes current partial hour)
 * - Start is calculated as (end - duration)
 *
 * This ensures queries align with the hourly bucketing in the database.
 */
export function parseStatsTimeRange(range: StatsTimeRangeValue, referenceTime?: number): { startDate: string; endDate: string } {
  const preset = STATS_TIME_RANGE_PRESETS.find((p) => p.value === range)
  if (!preset) {
    // Default to 24h if invalid range
    const now = referenceTime ? new Date(referenceTime) : new Date()
    const end = ceilToHour(now)
    const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
    return { startDate: start.toISOString(), endDate: end.toISOString() }
  }

  const now = referenceTime ? new Date(referenceTime) : new Date()
  // Ceil end to next hour to include current partial hour's data
  const end = ceilToHour(now)
  // Start is duration before the aligned end
  const start = new Date(end.getTime() - preset.minutes * 60 * 1000)

  return {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  }
}

/**
 * Get the appropriate granularity for a time range.
 * Shorter ranges use hourly, longer ranges use daily.
 */
export function getGranularityForRange(range: TimeRangeValue): "hourly" | "daily" {
  const preset = TIME_RANGE_PRESETS.find((p) => p.value === range)
  if (!preset) return "daily"
  // Use hourly for ranges <= 24 hours
  return preset.minutes <= 1440 ? "hourly" : "daily"
}
