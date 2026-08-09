/**
 * API client and types for GeoMetrikks backend.
 */

import axios from "axios"
import {
  apiV1GeoEventsFacetsGetGeoLogFacets,
  apiV1GeoEventsLogsGetGeoLogs,
  apiV1GeoEventsSummaryGetGeoLogSummary,
  apiV1GeoEventsTimeSeriesGetGeoLogTimeSeries,
  apiV1GeoEventsTopCitiesGetGeoLogTopCities,
  apiV1GeoEventsTopCountriesGetGeoLogTopCountries,
  apiV1GeoEventsTopIpsGetGeoLogTopIps,
  apiV1AnalyticsGeoTimeSeriesGetGeoTimeSeries,
  apiV1AnalyticsTimeSeriesGetTimeSeries,
  apiV1AnalyticsTopCitiesGetTopCities,
  apiV1AnalyticsTopCountriesGetTopCountries,
  apiV1AnalyticsTopIpsGetTopIps,
  apiV1AnalyticsTopUrlsGetTopUrls,
  apiV1AnalyticsTopUserAgentsGetTopUserAgents,
} from "@/generated/api/sdk.gen"
import { BROWSER_TZ } from "@/lib/datetime"
import type {
  GeoJsonFeatureCollection as GeoJSONFeatureCollection,
  SafeSettingsResponse,
  SystemSettingsResponse,
  SchedulerJobsResponse,
  SchedulerJobView,
  AboutResponse,
  CrowdSecStatusResponse,
  CrowdSecStatsResponse,
  AlertView,
  DecisionView,
  IpLocation,
  SessionUser,
  AuthDisabled,
} from "@/generated/api/types.gen"

export type {
  CrowdSecStatusResponse,
  CrowdSecStatsResponse,
  AlertView,
  DecisionView,
  IpLocation,
}

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

/** Discriminated union: username exists only on the session branch. With
 *  APP_AUTH_DISABLED=true the endpoints stay registered and report "disabled"
 *  rather than 404ing. Comes from the generated schema, not hand-rolled, so
 *  a backend change to the tagged union cannot silently leave this stale. */
export type MeResponse = SessionUser | AuthDisabled

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
  parsedLines: number
  pendingRecords: number
  /** Tailed log files that disappeared mid-flight; ingestion waits for them. */
  missingFiles: string[]
  /** Wall-clock of the most recent ingested record; null before the first. */
  lastRecordAt: string | null
}

export interface HealthResponse {
  status: "healthy" | "degraded"
  /** App start time; null in test harnesses without lifecycle startup. */
  startedAt: string | null
  ingestion: HealthIngestionStatus
  database: { reachable: boolean }
  /** dbBuildDate is the GeoLite2 build from the mmdb metadata. */
  geoip: { available: boolean; dbBuildDate: string | null }
  crowdsec: { enabled: boolean; lapiReachable: boolean | null }
  timestamp: string
}

export type RuntimeSettings = SafeSettingsResponse

// ============================================================================
// Types - Analytics API
// ============================================================================

export interface PeriodSummary {
  totalRequests: number
  totalGeoEvents: number
  uniqueIps: number
  uniqueCountries: number
  totalBytesSent: number
  avgBytesPerRequest: number
  status2xx: number
  status3xx: number
  status4xx: number
  status5xx: number
  avgRequestTime: number
  maxRequestTime: number
  malformedRequests: number
  errorRate: number
}

export interface PercentChange {
  logRecords: number | null
  geoRecords: number | null
  uniqueIps: number | null
  bytesSent: number | null
  avgRequestTime: number | null
  errorRate: number | null
  malformedRate: number | null
}

export interface SummaryResponse {
  startDate: string
  endDate: string
  currentPeriod: PeriodSummary
  previousPeriod: PeriodSummary | null
  percentChanges: PercentChange | null
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
  countryCode: string | null
  countryName: string | null
}

export interface TopIPDTO {
  ipAddress: string
  eventCount: number
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

/** Ingestion counters from /api/v1/stats; mirrors the backend's typed
 *  IngestionStatsResponse (geometrikks/domain/system/controllers/stats.py). */
export interface StatsResponse {
  totalParsedLines: number
  totalSkippedLines: number
  totalPendingRecords: number
  totalIgnoredLines: number
  totalProcessed: number
  isRunning: boolean
}

export async function fetchStats(): Promise<StatsResponse> {
  const { data } = await api.get<StatsResponse>("/stats")
  return data
}

export async function fetchRuntimeSettings(): Promise<RuntimeSettings> {
  const { data } = await api.get<RuntimeSettings>("/settings")
  return data
}

// ============================================================================
// Types & Functions - System API (settings page)
// ============================================================================

export async function fetchSystemSettings(): Promise<SystemSettingsResponse> {
  const { data } = await api.get<SystemSettingsResponse>("/system/settings")
  return data
}

export async function fetchSchedulerJobs(): Promise<SchedulerJobsResponse> {
  const { data } = await api.get<SchedulerJobsResponse>("/system/scheduler/jobs")
  return data
}

export async function runSchedulerJob(jobId: string): Promise<SchedulerJobView> {
  const { data } = await api.post<SchedulerJobView>(
    `/system/scheduler/jobs/${encodeURIComponent(jobId)}/run`,
  )
  return data
}

export async function fetchAbout(): Promise<AboutResponse> {
  const { data } = await api.get<AboutResponse>("/system/about")
  return data
}

// ============================================================================
// Types & Functions - CrowdSec API
// ============================================================================

export interface CrowdSecDecisionsPage {
  items: DecisionView[]
  total: number
  limit: number
  offset: number
}

/** Integration state; everything CrowdSec in the UI is gated on `enabled`. */
export async function fetchCrowdsecStatus(): Promise<CrowdSecStatusResponse> {
  const { data } = await api.get<CrowdSecStatusResponse>("/crowdsec/status")
  return data
}

/** One page of active decisions. Server defaults to local origins
 *  (crowdsec,cscli,geometrikks); pass `origins` to widen to CAPI/lists. */
export async function fetchCrowdsecDecisions(params?: {
  origins?: string
  currentPage?: number
  pageSize?: number
}): Promise<CrowdSecDecisionsPage> {
  const { data } = await api.get<CrowdSecDecisionsPage>("/crowdsec/decisions", {
    params: {
      origins: params?.origins || undefined,
      currentPage: params?.currentPage ?? 1,
      pageSize: params?.pageSize ?? 50,
    },
  })
  return data
}

/** Every actively banned IP across all origins (CAPI included), values only.
 *  Compact enough for the badge set even with a community blocklist. */
export async function fetchCrowdsecBannedIps(): Promise<string[]> {
  const { data } = await api.get<string[]>("/crowdsec/banned-ips")
  return data
}

/** Coordinates of banned IPs seen in this server's own traffic (map overlay).
 *  The window keeps the overlay in step with the map's time range; omitted
 *  bounds fall back to the server's 30d geo lookback. */
export async function fetchCrowdsecBannedLocations(params?: {
  fromTimestamp?: string
  toTimestamp?: string
}): Promise<IpLocation[]> {
  const { data } = await api.get<IpLocation[]>("/crowdsec/banned-locations", {
    params: {
      fromTimestamp: params?.fromTimestamp,
      toTimestamp: params?.toTimestamp,
    },
  })
  return data
}

/** Decision counts grouped by origin plus the most frequent scenarios. */
export async function fetchCrowdsecStats(): Promise<CrowdSecStatsResponse> {
  const { data } = await api.get<CrowdSecStatsResponse>("/crowdsec/stats")
  return data
}

/** Recent LAPI alert history; requires writeEnabled (machine credentials). */
export async function fetchCrowdsecAlerts(params?: {
  limit?: number
  since?: string
}): Promise<AlertView[]> {
  const { data } = await api.get<AlertView[]>("/crowdsec/alerts", {
    params: {
      limit: params?.limit ?? 50,
      since: params?.since || undefined,
    },
  })
  return data
}

/** Ban one IP. `duration` is a Go duration string (4h, 24h, 168h); server
 *  defaults apply to omitted duration/reason. Requires writeEnabled. The
 *  reason ends up in the alert message and the audit log. */
export async function banIp(
  ip: string,
  duration?: string,
  reason?: string,
): Promise<void> {
  await api.post("/crowdsec/ban", { ip, duration, reason: reason || undefined })
}

/** Delete all active decisions for one IP; resolves to the number deleted. */
export async function unbanIp(ip: string): Promise<number> {
  const { data } = await api.post<{ deleted: number }>("/crowdsec/unban", { ip })
  return data.deleted
}

export interface SummaryParams {
  startDate: string // ISO date string (YYYY-MM-DD)
  endDate: string
  comparePrevious?: boolean
}

export async function fetchSummary(params: SummaryParams): Promise<SummaryResponse> {
  const { data } = await api.get<SummaryResponse>("/analytics/summary", {
    params: {
      startDate: params.startDate,
      endDate: params.endDate,
      comparePrevious: params.comparePrevious ?? true,
    },
  })
  return data
}

export async function fetchLiveSummary(params: SummaryParams): Promise<SummaryResponse> {
  const { data } = await api.get<SummaryResponse>("/analytics/live-summary", {
    params: {
      startDate: params.startDate,
      endDate: params.endDate,
      comparePrevious: params.comparePrevious ?? true,
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
  /** Exact IPs to include; forces a raw geo_events scan on the backend. */
  ips?: string[]
  /** Exact IPs to exclude; forces a raw geo_events scan on the backend. */
  ipsExclude?: string[]
  /** Recording hostnames; forces a raw geo_events scan on the backend. */
  hostnames?: string[]
}

export async function fetchGeoJSON(params: GeoJSONParams): Promise<GeoJSONFeatureCollection> {
  const { data } = await api.get<GeoJSONFeatureCollection>("/geo-locations/geojson", {
    params: {
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      countryCode: params.countryCodes?.length ? params.countryCodes : undefined,
      city: params.cities?.length ? params.cities : undefined,
      ipAddressIn: params.ips?.length ? params.ips : undefined,
      ipAddressNotIn: params.ipsExclude?.length ? params.ipsExclude : undefined,
      hostnameIn: params.hostnames?.length ? params.hostnames : undefined,
    },
    // Litestar expects repeated keys (?countryCode=NO&countryCode=SE),
    // not axios' default bracket form (countryCode[]=NO).
    paramsSerializer: { indexes: null },
  })
  return data
}

// ============================================================================
// Types & Functions - Top IPs API
// ============================================================================

export interface GlobalTopIPsResponse {
  topIps: TopIPDTO[]
}

// ============================================================================
// Types - Top Countries API
// ============================================================================

export interface TopCountryDTO {
  countryCode: string
  countryName: string | null
  eventCount: number
}

export interface TopCountriesResponse {
  topCountries: TopCountryDTO[]
}

// ============================================================================
// Types - Cumulative Time Series API
// ============================================================================

export interface CumulativeDataPoint {
  timestamp: string
  cumulativeGeoEvents: number
  cumulativeAccessLogs: number
  cumulativeBytes: number
}

export interface CumulativeTimeSeriesResponse {
  granularity: "hourly" | "daily"
  startDate: string
  endDate: string
  data: CumulativeDataPoint[]
}

export interface LocationTopIPsResponse {
  locationId: number
  topIps: TopIPDTO[]
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
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
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
        fromTimestamp: params.fromTimestamp,
        toTimestamp: params.toTimestamp,
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
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      limit: params.limit ?? 10,
    },
  })
  return data
}

// ============================================================================
// Analytics fetchers on the generated SDK (types flow from the OpenAPI schema)
// ============================================================================

/**
 * Country/city/IP filters shared by the analytics page's six filterable
 * endpoints (not geo-time-series, which stays unfiltered). The generated
 * fetch client serializes arrays as repeated keys (?countryCode=NO&countryCode=SE)
 * by default, matching what Litestar expects.
 */
export interface AnalyticsFilterParams {
  countryCodes?: string[]
  cities?: string[]
  ips?: string[]
  ipsExclude?: string[]
}

export async function fetchTimeSeries(params: TimeSeriesParams & AnalyticsFilterParams) {
  const { data } = await apiV1AnalyticsTimeSeriesGetTimeSeries({
    query: {
      startDate: params.startDate,
      endDate: params.endDate,
      granularity: params.granularity,
      tz: BROWSER_TZ,
      countryCode: params.countryCodes?.length ? params.countryCodes : undefined,
      city: params.cities?.length ? params.cities : undefined,
      ipAddress: params.ips?.length ? params.ips : undefined,
      ipAddressNotIn: params.ipsExclude?.length ? params.ipsExclude : undefined,
    },
    throwOnError: true,
  })
  return data
}

export async function fetchGeoTimeSeries(params: TimeSeriesParams) {
  const { data } = await apiV1AnalyticsGeoTimeSeriesGetGeoTimeSeries({
    query: {
      startDate: params.startDate,
      endDate: params.endDate,
      granularity: params.granularity,
      tz: BROWSER_TZ,
    },
    throwOnError: true,
  })
  return data
}

export async function fetchTopUrls(params: TimeSeriesParams & { limit?: number } & AnalyticsFilterParams) {
  const { data } = await apiV1AnalyticsTopUrlsGetTopUrls({
    query: {
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit ?? 25,
      countryCode: params.countryCodes?.length ? params.countryCodes : undefined,
      city: params.cities?.length ? params.cities : undefined,
      ipAddress: params.ips?.length ? params.ips : undefined,
      ipAddressNotIn: params.ipsExclude?.length ? params.ipsExclude : undefined,
    },
    throwOnError: true,
  })
  return data
}

export async function fetchTopUserAgents(params: TimeSeriesParams & { limit?: number } & AnalyticsFilterParams) {
  const { data } = await apiV1AnalyticsTopUserAgentsGetTopUserAgents({
    query: {
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit ?? 25,
      countryCode: params.countryCodes?.length ? params.countryCodes : undefined,
      city: params.cities?.length ? params.cities : undefined,
      ipAddress: params.ips?.length ? params.ips : undefined,
      ipAddressNotIn: params.ipsExclude?.length ? params.ipsExclude : undefined,
    },
    throwOnError: true,
  })
  return data
}

export async function fetchTopIpStats(params: TimeSeriesParams & { limit?: number } & AnalyticsFilterParams) {
  const { data } = await apiV1AnalyticsTopIpsGetTopIps({
    query: {
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit ?? 25,
      countryCode: params.countryCodes?.length ? params.countryCodes : undefined,
      city: params.cities?.length ? params.cities : undefined,
      ipAddress: params.ips?.length ? params.ips : undefined,
      ipAddressNotIn: params.ipsExclude?.length ? params.ipsExclude : undefined,
    },
    throwOnError: true,
  })
  return data
}

export async function fetchTopCountryStats(params: TimeSeriesParams & { limit?: number } & AnalyticsFilterParams) {
  const { data } = await apiV1AnalyticsTopCountriesGetTopCountries({
    query: {
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit ?? 25,
      countryCode: params.countryCodes?.length ? params.countryCodes : undefined,
      city: params.cities?.length ? params.cities : undefined,
      ipAddress: params.ips?.length ? params.ips : undefined,
      ipAddressNotIn: params.ipsExclude?.length ? params.ipsExclude : undefined,
    },
    throwOnError: true,
  })
  return data
}

export async function fetchTopCityStats(params: TimeSeriesParams & { limit?: number } & AnalyticsFilterParams) {
  const { data } = await apiV1AnalyticsTopCitiesGetTopCities({
    query: {
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit ?? 25,
      countryCode: params.countryCodes?.length ? params.countryCodes : undefined,
      city: params.cities?.length ? params.cities : undefined,
      ipAddress: params.ips?.length ? params.ips : undefined,
      ipAddressNotIn: params.ipsExclude?.length ? params.ipsExclude : undefined,
    },
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
      startDate: params.startDate,
      endDate: params.endDate,
    },
  })
  return data
}

// ============================================================================
// Types & Functions - Geo Logs API (generated SDK; types flow from OpenAPI)
// ============================================================================

/**
 * Full geo-logs filter set, shared by every fetcher on the page so the map,
 * stats, chart, top lists and table reshape together.
 */
export interface GeoLogFilterParams {
  countryCodes?: string[]
  cities?: string[]
  ips?: string[]
  ipsExclude?: string[]
  hostnames?: string[]
}

/** Shared query fragment; empty arrays are dropped from the query string. */
function geoLogFilterQuery(params: GeoLogFilterParams) {
  return {
    countryCodeIn: params.countryCodes?.length ? params.countryCodes : undefined,
    cityIn: params.cities?.length ? params.cities : undefined,
    ipAddressIn: params.ips?.length ? params.ips : undefined,
    ipAddressNotIn: params.ipsExclude?.length ? params.ipsExclude : undefined,
    hostnameIn: params.hostnames?.length ? params.hostnames : undefined,
  }
}

export interface GeoLogsWindowParams {
  fromTimestamp: string
  toTimestamp: string
}

export type GeoLogSortOrder = "asc" | "desc"

export type GeoLogSortField =
  | "city"
  | "postalCode"
  | "state"
  | "countryCode"
  | "countryName"
  | "ipAddress"
  | "latitude"
  | "longitude"
  | "eventCount"
  | "lastSeen"

/** camelCase sort key -> backend snake_case column name for `orderBy`. */
const GEO_LOG_SORT_FIELD_TO_COLUMN: Record<GeoLogSortField, string> = {
  city: "city",
  postalCode: "postal_code",
  state: "state",
  countryCode: "country_code",
  countryName: "country_name",
  ipAddress: "ip_address",
  latitude: "latitude",
  longitude: "longitude",
  eventCount: "event_count",
  lastSeen: "last_seen",
}

export async function fetchGeoLogs(
  params: GeoLogsWindowParams & GeoLogFilterParams & {
    currentPage?: number
    pageSize?: number
    sortField?: GeoLogSortField
    sortOrder?: GeoLogSortOrder
  },
) {
  const { data } = await apiV1GeoEventsLogsGetGeoLogs({
    query: {
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      currentPage: params.currentPage ?? 1,
      pageSize: params.pageSize ?? 50,
      orderBy: params.sortField ? GEO_LOG_SORT_FIELD_TO_COLUMN[params.sortField] : undefined,
      sortOrder: params.sortOrder ?? "desc",
      ...geoLogFilterQuery(params),
    },
    throwOnError: true,
  })
  return data
}

export async function fetchGeoLogSummary(
  params: GeoLogsWindowParams & GeoLogFilterParams & { comparePrevious?: boolean },
) {
  const { data } = await apiV1GeoEventsSummaryGetGeoLogSummary({
    query: {
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      comparePrevious: params.comparePrevious ?? true,
      ...geoLogFilterQuery(params),
    },
    throwOnError: true,
  })
  return data
}

export async function fetchGeoLogTimeSeries(
  params: GeoLogsWindowParams & GeoLogFilterParams & { granularity?: "hourly" | "daily" },
) {
  const { data } = await apiV1GeoEventsTimeSeriesGetGeoLogTimeSeries({
    query: {
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      granularity: params.granularity,
      tz: BROWSER_TZ,
      ...geoLogFilterQuery(params),
    },
    throwOnError: true,
  })
  return data
}

export async function fetchGeoLogTopIps(
  params: GeoLogsWindowParams & GeoLogFilterParams & { limit?: number },
) {
  const { data } = await apiV1GeoEventsTopIpsGetGeoLogTopIps({
    query: {
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      limit: params.limit ?? 10,
      ...geoLogFilterQuery(params),
    },
    throwOnError: true,
  })
  return data
}

export async function fetchGeoLogTopCountries(
  params: GeoLogsWindowParams & GeoLogFilterParams & { limit?: number },
) {
  const { data } = await apiV1GeoEventsTopCountriesGetGeoLogTopCountries({
    query: {
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      limit: params.limit ?? 10,
      ...geoLogFilterQuery(params),
    },
    throwOnError: true,
  })
  return data
}

export async function fetchGeoLogTopCities(
  params: GeoLogsWindowParams & GeoLogFilterParams & { limit?: number },
) {
  const { data } = await apiV1GeoEventsTopCitiesGetGeoLogTopCities({
    query: {
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      limit: params.limit ?? 10,
      ...geoLogFilterQuery(params),
    },
    throwOnError: true,
  })
  return data
}

/** Distinct country/city/hostname values present in the geo data. */
export async function fetchGeoEventFacets() {
  const { data } = await apiV1GeoEventsFacetsGetGeoLogFacets({ throwOnError: true })
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
  /** IPs to exclude. */
  ipAddressNotIn?: string[]
  /** HTTP method(s) to include. */
  methodIn?: string[]
  /** Exact host match(es), chosen from the facets list. */
  hostIn?: string[]
  /** Hosts to exclude. */
  hostNotIn?: string[]
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
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      currentPage: params.currentPage ?? 1,
      pageSize: params.pageSize ?? 50,
      searchString: params.searchString || undefined,
      ipAddressIn: params.ipAddressIn?.length ? params.ipAddressIn : undefined,
      ipAddressNotIn: params.ipAddressNotIn?.length ? params.ipAddressNotIn : undefined,
      methodIn: params.methodIn?.length ? params.methodIn : undefined,
      hostIn: params.hostIn?.length ? params.hostIn : undefined,
      hostNotIn: params.hostNotIn?.length ? params.hostNotIn : undefined,
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
  /** Sorted alphabetically. */
  hosts: string[]
}

/** Distinct country/city/host values present in the data, for the filter dropdowns. */
export async function fetchAccessLogFacets(): Promise<AccessLogFacets> {
  const { data } = await api.get<AccessLogFacets>("/access-logs/facets")
  return data
}

// ============================================================================
// Access log debug (raw/malformed lines)
// ============================================================================

export interface AccessLogDebugEntry {
  id: number
  createdAt: string
  rawLine: string
  isMalformed: boolean
  accessLogId: number | null
  parseError: string | null
  /** Denormalized access-log fields; null when the line never parsed into a log. */
  timestamp: string | null
  ipAddress: string | null
  method: string | null
  url: string | null
  host: string | null
  statusCode: number | null
  countryCode: string | null
  countryName: string | null
  city: string | null
  userAgent: string | null
}

export interface AccessLogDebugPage {
  items: AccessLogDebugEntry[]
  total: number
  limit: number
  offset: number
}

/** Columns the debug table can sort by (must match the backend allowlist). */
export type AccessLogDebugSortField =
  | "createdAt" | "isMalformed" | "parseError"
  | "timestamp" | "statusCode" | "ipAddress" | "host" | "countryCode" | "city"

/** camelCase sort key -> backend snake_case column name for `orderBy`. */
const DEBUG_SORT_FIELD_TO_COLUMN: Record<AccessLogDebugSortField, string> = {
  createdAt: "created_at",
  isMalformed: "is_malformed",
  parseError: "parse_error",
  timestamp: "timestamp",
  statusCode: "status_code",
  ipAddress: "ip_address",
  host: "host",
  countryCode: "country_code",
  city: "city",
}

export interface AccessLogDebugParams {
  fromTimestamp: string
  toTimestamp: string
  currentPage?: number
  pageSize?: number
  /** Free-text search across raw_line / parse_error. */
  searchString?: string
  /** Exact IP match(es) on the debug row's denormalized ip_address. */
  ipAddressIn?: string[]
  /** Exact ISO-3166 alpha-2 country code match(es); unlinked rows are excluded. */
  countryCodeIn?: string[]
  /** Exact city match(es); unlinked rows are excluded. */
  cityIn?: string[]
  /** true = malformed only, false = well-formed only, undefined = all. */
  malformed?: boolean
  sortField?: AccessLogDebugSortField
  sortOrder?: SortOrder
}

export async function fetchAccessLogDebug(
  params: AccessLogDebugParams,
): Promise<AccessLogDebugPage> {
  const { data } = await api.get<AccessLogDebugPage>("/access-log-debug/", {
    params: {
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
      currentPage: params.currentPage ?? 1,
      pageSize: params.pageSize ?? 50,
      searchString: params.searchString || undefined,
      ipAddressIn: params.ipAddressIn?.length ? params.ipAddressIn : undefined,
      countryCodeIn: params.countryCodeIn?.length ? params.countryCodeIn : undefined,
      cityIn: params.cityIn?.length ? params.cityIn : undefined,
      malformed: params.malformed,
      orderBy: params.sortField ? DEBUG_SORT_FIELD_TO_COLUMN[params.sortField] : undefined,
      sortOrder: params.sortField ? params.sortOrder ?? "desc" : undefined,
    },
    // Litestar expects repeated keys (?cityIn=a&cityIn=b), not bracket form.
    paramsSerializer: { indexes: null },
  })
  return data
}

export interface ParseErrorCount {
  error: string
  count: number
}

export interface AccessLogDebugStats {
  total: number
  malformed: number
  topParseError: ParseErrorCount | null
}

export async function fetchAccessLogDebugStats(params: {
  fromTimestamp: string
  toTimestamp: string
}): Promise<AccessLogDebugStats> {
  const { data } = await api.get<AccessLogDebugStats>("/access-log-debug/stats", {
    params: {
      fromTimestamp: params.fromTimestamp,
      toTimestamp: params.toTimestamp,
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
