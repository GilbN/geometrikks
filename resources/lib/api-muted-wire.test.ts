import { beforeEach, expect, it, vi } from "vite-plus/test"

const sdk = vi.hoisted(() => ({
  topAsns: vi.fn(),
  timeSeries: vi.fn(),
  topUrls: vi.fn(),
  topUserAgents: vi.fn(),
  topIps: vi.fn(),
  topCountries: vi.fn(),
  topCities: vi.fn(),
  geoLogs: vi.fn(),
  geoSummary: vi.fn(),
}))
vi.mock("@/generated/api/sdk.gen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/generated/api/sdk.gen")>()),
  apiV1AnalyticsTopAsnsGetTopAsns: sdk.topAsns,
  apiV1AnalyticsTimeSeriesGetTimeSeries: sdk.timeSeries,
  apiV1AnalyticsTopUrlsGetTopUrls: sdk.topUrls,
  apiV1AnalyticsTopUserAgentsGetTopUserAgents: sdk.topUserAgents,
  apiV1AnalyticsTopIpsGetTopIps: sdk.topIps,
  apiV1AnalyticsTopCountriesGetTopCountries: sdk.topCountries,
  apiV1AnalyticsTopCitiesGetTopCities: sdk.topCities,
  apiV1GeoEventsLogsGetGeoLogs: sdk.geoLogs,
  apiV1GeoEventsSummaryGetGeoLogSummary: sdk.geoSummary,
}))
import {
  api,
  fetchAccessLogs,
  fetchGeoJSON,
  fetchGeoLogSummary,
  fetchGeoLogs,
  fetchTimeSeries,
  fetchTopAsns,
  fetchTopCityStats,
  fetchTopCountryStats,
  fetchTopIpStats,
  fetchTopUrls,
  fetchTopUserAgents,
} from "./api"

const window = { startDate: "2026-01-01T00:00:00Z", endDate: "2026-01-02T00:00:00Z" }
const geoWindow = { fromTimestamp: window.startDate, toTimestamp: window.endDate }

beforeEach(() => {
  vi.restoreAllMocks()
  for (const fn of Object.values(sdk)) fn.mockReset().mockResolvedValue({ data: {} })
})

const analyticsFetchers = [
  ["fetchTimeSeries", fetchTimeSeries, sdk.timeSeries],
  ["fetchTopUrls", fetchTopUrls, sdk.topUrls],
  ["fetchTopUserAgents", fetchTopUserAgents, sdk.topUserAgents],
  ["fetchTopAsns", fetchTopAsns, sdk.topAsns],
  ["fetchTopIpStats", fetchTopIpStats, sdk.topIps],
  ["fetchTopCountryStats", fetchTopCountryStats, sdk.topCountries],
  ["fetchTopCityStats", fetchTopCityStats, sdk.topCities],
] as const

it.each(analyticsFetchers)(
  "%s sends excludeMutedIps only when asked",
  async (_name, fetcher, sdkFn) => {
    await fetcher({ ...window, excludeMutedIps: true })
    expect(sdkFn.mock.calls[0][0].query.excludeMutedIps).toBe(true)
    sdkFn.mockClear()
    await fetcher({ ...window })
    expect(sdkFn.mock.calls[0][0].query.excludeMutedIps).toBeUndefined()
  },
)

it.each([
  [
    "fetchGeoLogs",
    (flag?: boolean) => fetchGeoLogs({ ...geoWindow, excludeMutedIps: flag }),
    sdk.geoLogs,
  ],
  [
    "fetchGeoLogSummary",
    (flag?: boolean) => fetchGeoLogSummary({ ...geoWindow, excludeMutedIps: flag }),
    sdk.geoSummary,
  ],
] as const)("%s sends excludeMutedIps only when asked", async (_name, call, sdkFn) => {
  await call(true)
  expect(sdkFn.mock.calls[0][0].query.excludeMutedIps).toBe(true)
  sdkFn.mockClear()
  await call(undefined)
  expect(sdkFn.mock.calls[0][0].query.excludeMutedIps).toBeUndefined()
})

it("fetchGeoJSON sends excludeMutedIps only when asked", async () => {
  const get = vi.spyOn(api, "get").mockResolvedValue({ data: {} })
  await fetchGeoJSON({ ...geoWindow, excludeMutedIps: true })
  expect((get.mock.calls[0][1] as { params: Record<string, unknown> }).params.excludeMutedIps).toBe(
    true,
  )
  await fetchGeoJSON({ ...geoWindow })
  expect(
    (get.mock.calls[1][1] as { params: Record<string, unknown> }).params.excludeMutedIps,
  ).toBeUndefined()
})

it("fetchAccessLogs sends excludeMutedIps only when asked", async () => {
  const get = vi.spyOn(api, "get").mockResolvedValue({ data: {} })
  await fetchAccessLogs({ ...geoWindow, excludeMutedIps: true })
  expect((get.mock.calls[0][1] as { params: Record<string, unknown> }).params.excludeMutedIps).toBe(
    true,
  )
  await fetchAccessLogs({ ...geoWindow })
  expect(
    (get.mock.calls[1][1] as { params: Record<string, unknown> }).params.excludeMutedIps,
  ).toBeUndefined()
})
