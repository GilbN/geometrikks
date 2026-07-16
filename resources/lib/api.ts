/**
 * API client and types for GeoMetrikks backend.
 */

import axios from "axios"
import {
  apiV1AnalyticsGeoTimeSeriesGetGeoTimeSeries,
  apiV1AnalyticsTimeSeriesGetTimeSeries,
  apiV1AnalyticsTopCitiesGetTopCities,
  apiV1AnalyticsTopCountriesGetTopCountries,
  apiV1AnalyticsTopIpsGetTopIps,
  apiV1AnalyticsTopUrlsGetTopUrls,
  apiV1AnalyticsTopUserAgentsGetTopUserAgents,
} from "@/generated/api/sdk.gen"
import type {
  GeoJsonFeatureCollection as GeoJSONFeatureCollection,
  SafeSettingsResponse,
} from "@/generated/api/types.gen"

// Create axios instance with base configuration
export const api = axios.create({
  baseURL: "/api/v1",
  headers: {
    "Content-Type": "application/json",
  },
})

// Redirect to the login page on any 401 from the API (session expired or
// not yet logged in). Skip when already on /login to avoid a redirect loop.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      error?.response?.status === 401 &&
      window.location.pathname !== "/login" &&
      !error?.config?.url?.includes("/auth/login")
    ) {
      window.location.href = "/login"
    }
    return Promise.reject(error)
  }
)

// ============================================================================
// Types & Functions - Auth API
// ============================================================================

export interface MeResponse {
  username: string
}

export async function login(username: string, password: string): Promise<MeResponse> {
  const { data } = await api.post<MeResponse>("/auth/login", { username, password })
  return data
}

export async function logout(): Promise<void> {
  await api.post("/auth/logout")
}

export async function fetchMe(): Promise<MeResponse> {
  const { data } = await api.get<MeResponse>("/auth/me")
  return data
}

// ============================================================================
// Types - Health API
// ============================================================================

export interface HealthIngestionStatus {
  running: boolean
  parsed_lines: number
  pending_records: number
}

export interface HealthResponse {
  status: "healthy" | "degraded"
  ingestion: HealthIngestionStatus
  database: { reachable: boolean }
  geoip: { available: boolean }
  timestamp: string
}

export type RuntimeSettings = SafeSettingsResponse

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
  log_records: number | null
  geo_records: number | null
  unique_ips: number | null
  bytes_sent: number | null
  avg_request_time: number | null
  error_rate: number | null
  malformed_rate: number | null
}

export interface SummaryResponse {
  start_date: string
  end_date: string
  current_period: PeriodSummary
  previous_period: PeriodSummary | null
  percent_changes: PercentChange | null
}

// Time-series shapes come from the generated client (the old manual
// interfaces drifted: they lacked the percentile and unique_cities fields).
export type {
  TimeSeriesDataPoint,
  TimeSeriesResponse,
  GeoEventsDataPoint,
  GeoEventsTimeSeriesResponse,
} from "@/generated/api/types.gen"

// ============================================================================
// Types - GeoJSON API
// ============================================================================

export interface EmbeddedLocationDTO {
  id: number
  latitude: number
  longitude: number
  city: string | null
  country_code: string | null
  country_name: string | null
}

export interface TopIPDTO {
  ip_address: string
  event_count: number
  location: EmbeddedLocationDTO | null
}

// GeoJSON shapes come from the generated client; the aliases keep the
// codebase's GeoJSON* casing.
export type {
  GeoJsonFeatureCollection as GeoJSONFeatureCollection,
  GeoJsonFeature as GeoJSONFeature,
  GeoJsonFeatureProperties as GeoJSONFeatureProperties,
  GeoJsonFeatureStats as GeoJSONFeatureStats,
  GeoJsonPointGeometry as GeoJSONPointGeometry,
} from "@/generated/api/types.gen"

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch service health status.
 * Note: /health is at root level, not under /api/v1
 */
export async function fetchHealth(): Promise<HealthResponse> {
  const { data } = await axios.get<HealthResponse>("/health")
  return data
}

export async function fetchRuntimeSettings(): Promise<RuntimeSettings> {
  const { data } = await api.get<RuntimeSettings>("/settings")
  return data
}

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

export async function fetchLiveSummary(params: SummaryParams): Promise<SummaryResponse> {
  const { data } = await api.get<SummaryResponse>("/analytics/live-summary", {
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

export type ChartGranularity = "auto" | "hourly" | "daily"


export interface GeoJSONParams {
  fromTimestamp: string // Full ISO timestamp
  toTimestamp: string
  countryCodes?: string[]
  cities?: string[]
}

export async function fetchGeoJSON(params: GeoJSONParams): Promise<GeoJSONFeatureCollection> {
  const { data } = await api.get<GeoJSONFeatureCollection>("/geo-locations/geojson", {
    params: {
      from_timestamp: params.fromTimestamp,
      to_timestamp: params.toTimestamp,
      country_code: params.countryCodes?.length ? params.countryCodes : undefined,
      city: params.cities?.length ? params.cities : undefined,
    },
    // Litestar expects repeated keys (?country_code=NO&country_code=SE),
    // not axios' default bracket form (country_code[]=NO).
    paramsSerializer: { indexes: null },
  })
  return data
}

// ============================================================================
// Types & Functions - Top IPs API
// ============================================================================

export interface GlobalTopIPsResponse {
  top_ips: TopIPDTO[]
}

// ============================================================================
// Types - Top Countries API
// ============================================================================

export interface TopCountryDTO {
  country_code: string
  country_name: string | null
  event_count: number
}

export interface TopCountriesResponse {
  top_countries: TopCountryDTO[]
}

// ============================================================================
// Types - Cumulative Time Series API
// ============================================================================

export interface CumulativeDataPoint {
  timestamp: string
  cumulative_geo_events: number
  cumulative_access_logs: number
  cumulative_bytes: number
}

export interface CumulativeTimeSeriesResponse {
  granularity: "hourly" | "daily"
  start_date: string
  end_date: string
  data: CumulativeDataPoint[]
}

export interface LocationTopIPsResponse {
  location_id: number
  top_ips: TopIPDTO[]
}

export interface TopIPsParams {
  fromTimestamp: string
  toTimestamp: string
  limit?: number
}

export interface LocationTopIPsParams extends TopIPsParams {
  locationId: number
}

/**
 * Fetch global top IPs by event count with their primary locations.
 */
export async function fetchGlobalTopIPs(params: TopIPsParams): Promise<GlobalTopIPsResponse> {
  const { data } = await api.get<GlobalTopIPsResponse>("/geo-locations/top-ips", {
    params: {
      from_timestamp: params.fromTimestamp,
      to_timestamp: params.toTimestamp,
      limit: params.limit ?? 5,
    },
  })
  return data
}

/**
 * Fetch top IPs for a specific location.
 */
export async function fetchLocationTopIPs(params: LocationTopIPsParams): Promise<LocationTopIPsResponse> {
  const { data } = await api.get<LocationTopIPsResponse>(
    `/geo-locations/${params.locationId}/top-ips`,
    {
      params: {
        from_timestamp: params.fromTimestamp,
        to_timestamp: params.toTimestamp,
        limit: params.limit ?? 5,
      },
    }
  )
  return data
}

/**
 * Fetch top countries by event count.
 */
export async function fetchTopCountries(params: TopIPsParams): Promise<TopCountriesResponse> {
  const { data } = await api.get<TopCountriesResponse>("/geo-locations/top-countries", {
    params: {
      from_timestamp: params.fromTimestamp,
      to_timestamp: params.toTimestamp,
      limit: params.limit ?? 10,
    },
  })
  return data
}

// ============================================================================
// Analytics fetchers on the generated SDK (types flow from the OpenAPI schema)
// ============================================================================

export async function fetchTimeSeries(params: TimeSeriesParams) {
  const { data } = await apiV1AnalyticsTimeSeriesGetTimeSeries({
    query: { start_date: params.startDate, end_date: params.endDate, granularity: params.granularity },
    throwOnError: true,
  })
  return data
}

export async function fetchGeoTimeSeries(params: TimeSeriesParams) {
  const { data } = await apiV1AnalyticsGeoTimeSeriesGetGeoTimeSeries({
    query: { start_date: params.startDate, end_date: params.endDate, granularity: params.granularity },
    throwOnError: true,
  })
  return data
}

export async function fetchTopUrls(params: TimeSeriesParams & { limit?: number }) {
  const { data } = await apiV1AnalyticsTopUrlsGetTopUrls({
    query: { start_date: params.startDate, end_date: params.endDate, limit: params.limit ?? 25 },
    throwOnError: true,
  })
  return data
}

export async function fetchTopUserAgents(params: TimeSeriesParams & { limit?: number }) {
  const { data } = await apiV1AnalyticsTopUserAgentsGetTopUserAgents({
    query: { start_date: params.startDate, end_date: params.endDate, limit: params.limit ?? 25 },
    throwOnError: true,
  })
  return data
}

export async function fetchTopIpStats(params: TimeSeriesParams & { limit?: number }) {
  const { data } = await apiV1AnalyticsTopIpsGetTopIps({
    query: { start_date: params.startDate, end_date: params.endDate, limit: params.limit ?? 25 },
    throwOnError: true,
  })
  return data
}

export async function fetchTopCountryStats(params: TimeSeriesParams & { limit?: number }) {
  const { data } = await apiV1AnalyticsTopCountriesGetTopCountries({
    query: { start_date: params.startDate, end_date: params.endDate, limit: params.limit ?? 25 },
    throwOnError: true,
  })
  return data
}

export async function fetchTopCityStats(params: TimeSeriesParams & { limit?: number }) {
  const { data } = await apiV1AnalyticsTopCitiesGetTopCities({
    query: { start_date: params.startDate, end_date: params.endDate, limit: params.limit ?? 25 },
    throwOnError: true,
  })
  return data
}

/**
 * Fetch cumulative time series data.
 */
export async function fetchCumulativeTimeSeries(params: TimeSeriesParams): Promise<CumulativeTimeSeriesResponse> {
  const { data } = await api.get<CumulativeTimeSeriesResponse>("/analytics/time-series/cumulative", {
    params: {
      start_date: params.startDate,
      end_date: params.endDate,
    },
  })
  return data
}

// ============================================================================
// Types & Functions - Access Logs API
// ============================================================================

export interface AccessLog {
  id: number
  timestamp: string
  ipAddress: string
  remoteUser: string | null
  method: string | null
  url: string | null
  httpVersion: string | null
  statusCode: number
  bytesSent: number
  referrer: string | null
  userAgent: string | null
  requestTime: number
  upstreamResponseTime: number | null
  host: string | null
  countryCode: string | null
  countryName: string | null
  city: string | null
}

export interface AccessLogsPage {
  items: AccessLog[]
  total: number
  limit: number
  offset: number
}

/** Columns the history table can sort by (must match the backend allowlist). */
export type AccessLogSortField =
  | "timestamp" | "statusCode" | "bytesSent" | "requestTime"
  | "method" | "ipAddress" | "host" | "url"
export type SortOrder = "asc" | "desc"

/** camelCase sort key -> backend snake_case column name for `orderBy`. */
const SORT_FIELD_TO_COLUMN: Record<AccessLogSortField, string> = {
  timestamp: "timestamp",
  statusCode: "status_code",
  bytesSent: "bytes_sent",
  requestTime: "request_time",
  method: "method",
  ipAddress: "ip_address",
  host: "host",
  url: "url",
}

export interface AccessLogsParams {
  fromTimestamp: string
  toTimestamp: string
  currentPage?: number
  pageSize?: number
  /** Free-text search across url / referrer / user-agent. */
  searchString?: string
  /** Exact IP match(es). */
  ipAddressIn?: string[]
  /** HTTP method(s) to include. */
  methodIn?: string[]
  /** Case-insensitive substring match on host (domain). */
  host?: string
  /** Exact city match(es). */
  cityIn?: string[]
  /** Exact ISO-3166 alpha-2 country code match(es). */
  countryCodeIn?: string[]
  statusIn?: number[]
  sortField?: AccessLogSortField
  sortOrder?: SortOrder
}

export async function fetchAccessLogs(params: AccessLogsParams): Promise<AccessLogsPage> {
  const { data } = await api.get<AccessLogsPage>("/access-logs/", {
    params: {
      from_timestamp: params.fromTimestamp,
      to_timestamp: params.toTimestamp,
      currentPage: params.currentPage ?? 1,
      pageSize: params.pageSize ?? 50,
      searchString: params.searchString || undefined,
      ipAddressIn: params.ipAddressIn?.length ? params.ipAddressIn : undefined,
      methodIn: params.methodIn?.length ? params.methodIn : undefined,
      host: params.host || undefined,
      cityIn: params.cityIn?.length ? params.cityIn : undefined,
      countryCodeIn: params.countryCodeIn?.length ? params.countryCodeIn : undefined,
      statusIn: params.statusIn?.length ? params.statusIn : undefined,
      orderBy: params.sortField ? SORT_FIELD_TO_COLUMN[params.sortField] : undefined,
      sortOrder: params.sortField ? params.sortOrder ?? "desc" : undefined,
    },
    // Litestar expects repeated keys (?methodIn=GET&methodIn=POST),
    // not axios' default bracket form (methodIn[]=GET).
    paramsSerializer: { indexes: null },
  })
  return data
}

export interface CountryFacet {
  /** ISO-3166 alpha-2 code, e.g. "NO". */
  code: string
  /** Display name, e.g. "Norway". */
  name: string
}

export interface AccessLogFacets {
  /** Sorted by name. */
  countries: CountryFacet[]
  /** Sorted alphabetically. */
  cities: string[]
}

/** Distinct country/city values present in the data, for the filter dropdowns. */
export async function fetchAccessLogFacets(): Promise<AccessLogFacets> {
  const { data } = await api.get<AccessLogFacets>("/access-logs/facets")
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

export type TimeRangeValue =
  | "5m" | "15m" | "30m" | "1h" | "2h" | "3h" | "6h" | "12h" | "24h"
  | "7d" | "14d" | "30d" | "90d" | "180d" | "365d"
  // Grafana-style presets
  | "today" | "this_week" | "this_month"
  | "yesterday" | "last_week" | "last_month"
  | "custom"

export interface CustomTimeRange {
  from: string // ISO timestamp
  to: string
}

export interface TimeRangePreset {
  label: string
  value: TimeRangeValue
  minutes: number
}

export const TIME_RANGE_PRESETS: TimeRangePreset[] = [
  { label: "5m", value: "5m", minutes: 5 },
  { label: "15m", value: "15m", minutes: 15 },
  { label: "30m", value: "30m", minutes: 30 },
  { label: "1h", value: "1h", minutes: 60 },
  { label: "2h", value: "2h", minutes: 120 },
  { label: "3h", value: "3h", minutes: 180 },
  { label: "6h", value: "6h", minutes: 360 },
  { label: "12h", value: "12h", minutes: 720 },
  { label: "24h", value: "24h", minutes: 1440 },
  { label: "7d", value: "7d", minutes: 10080 },
  { label: "14d", value: "14d", minutes: 20160 },
  { label: "30d", value: "30d", minutes: 43200 },
  { label: "90d", value: "90d", minutes: 129600 },
  { label: "180d", value: "180d", minutes: 259200 },
  { label: "365d", value: "365d", minutes: 525600 },
  // Grafana-style presets (computed dynamically)
  { label: "Today", value: "today", minutes: -1 },
  { label: "Yesterday", value: "yesterday", minutes: -1 },
  { label: "This week", value: "this_week", minutes: -1 },
  { label: "Last week", value: "last_week", minutes: -1 },
  { label: "This month", value: "this_month", minutes: -1 },
  { label: "Last month", value: "last_month", minutes: -1 },
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
 * Handles both relative (5m, 7d) and Grafana-style (today, this_week) presets.
 */
export function parseTimeRange(
  range: TimeRangeValue,
  referenceTime?: number,
  customRange?: CustomTimeRange | null,
): { startDate: string; endDate: string } {
  if (range === "custom" && customRange) {
    return { startDate: customRange.from, endDate: customRange.to }
  }

  const now = referenceTime ? new Date(referenceTime) : new Date()

  // Handle Grafana-style computed ranges
  switch (range) {
    case "today": {
      const start = new Date(now)
      start.setHours(0, 0, 0, 0)
      return { startDate: start.toISOString(), endDate: now.toISOString() }
    }
    case "yesterday": {
      const start = new Date(now)
      start.setDate(start.getDate() - 1)
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setHours(23, 59, 59, 999)
      return { startDate: start.toISOString(), endDate: end.toISOString() }
    }
    case "this_week": {
      const start = new Date(now)
      const dayOfWeek = start.getDay()
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1 // Monday = 0
      start.setDate(start.getDate() - diff)
      start.setHours(0, 0, 0, 0)
      return { startDate: start.toISOString(), endDate: now.toISOString() }
    }
    case "last_week": {
      const start = new Date(now)
      const dayOfWeek = start.getDay()
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      start.setDate(start.getDate() - diff - 7) // Go back to last Monday
      start.setHours(0, 0, 0, 0)
      const end = new Date(start)
      end.setDate(end.getDate() + 6)
      end.setHours(23, 59, 59, 999)
      return { startDate: start.toISOString(), endDate: end.toISOString() }
    }
    case "this_month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
      return { startDate: start.toISOString(), endDate: now.toISOString() }
    }
    case "last_month": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0)
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
      return { startDate: start.toISOString(), endDate: end.toISOString() }
    }
  }

  // Handle relative time ranges (5m, 7d, etc.)
  const preset = TIME_RANGE_PRESETS.find((p) => p.value === range)
  if (!preset || preset.minutes < 0) {
    // Default to 7 days if invalid range
    const start = new Date(now)
    start.setDate(start.getDate() - 7)
    return { startDate: start.toISOString(), endDate: now.toISOString() }
  }

  const start = new Date(now.getTime() - preset.minutes * 60 * 1000)

  return {
    startDate: start.toISOString(),
    endDate: now.toISOString(),
  }
}

/** Auto = hourly up to 7 days, daily above (hourly buckets beyond 7d are noise). */
export function resolveChartGranularity(
  granularity: ChartGranularity,
  range: TimeRangeValue,
  customRange?: CustomTimeRange | null,
): "hourly" | "daily" {
  if (granularity !== "auto") return granularity
  const { startDate, endDate } = parseTimeRange(range, Date.now(), customRange)
  const days = (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000
  return days > 7 ? "daily" : "hourly"
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
