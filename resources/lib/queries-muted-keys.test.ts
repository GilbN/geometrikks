import { beforeEach, expect, it, vi } from "vite-plus/test"
import type { MutedScope } from "./muted-ips"

const mocks = vi.hoisted(() => ({
  options: [] as Array<{
    queryKey: unknown[]
    queryFn: () => unknown
    placeholderData?: unknown
  }>,
  analytics: undefined as unknown,
  geo: undefined as unknown,
  fetchTopAsns: vi.fn().mockResolvedValue({}),
  fetchAccessLogs: vi.fn().mockResolvedValue({}),
}))
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: (typeof mocks.options)[number]) => {
    mocks.options.push(options)
    return { data: undefined, isPlaceholderData: false }
  },
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
  keepPreviousData: (previous: unknown) => previous,
}))
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => [initial, () => {}],
}))
vi.mock("./time-range-context", () => ({
  useTimeRange: () => ({
    range: "24h",
    customRange: null,
    granularity: "hourly",
    refetchInterval: false,
    lastRefresh: 1,
  }),
}))
vi.mock("./analytics-filters-context", () => ({ useAnalyticsFilters: () => mocks.analytics }))
vi.mock("./geo-log-filters-context", () => ({ useGeoLogFilters: () => mocks.geo }))
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  fetchTopAsns: mocks.fetchTopAsns,
  fetchAccessLogs: mocks.fetchAccessLogs,
  fetchGeoLogTimeSeries: vi.fn().mockResolvedValue({}),
}))
import { DEFAULT_MUTED_SCOPE } from "./muted-ips"
import { useAccessLogs, useGeoLogSparklines, useGeoLogTimeSeries, useTopAsns } from "./queries"
import { makeToggleMuted, pageToClamp } from "./use-muted-page"

const flagged: MutedScope = { flag: true, version: "abc12345", count: 2, chip: "hiding" }
const filters = { countryCodes: [], cities: [], ips: [], ipsExclude: [], asns: [], asnsExclude: [] }

beforeEach(() => {
  mocks.options = []
  mocks.fetchTopAsns.mockClear()
  mocks.fetchAccessLogs.mockClear()
  mocks.analytics = { filters, muted: flagged }
  mocks.geo = { filters, muted: flagged }
})

it("keys and sends the flag on a flagged Analytics query", async () => {
  useTopAsns()
  const options = mocks.options.at(-1)!
  expect(JSON.stringify(options.queryKey)).toContain(
    '"excludeMutedIps":true,"mutedIpsVersion":"abc12345"',
  )
  await options.queryFn()
  expect(mocks.fetchTopAsns).toHaveBeenCalledWith(
    expect.objectContaining({ excludeMutedIps: true }),
  )
})

it("keeps the flag out of Overview's key and request", async () => {
  mocks.analytics = { filters, muted: DEFAULT_MUTED_SCOPE }
  useTopAsns()
  const options = mocks.options.at(-1)!
  expect(JSON.stringify(options.queryKey)).not.toContain("excludeMutedIps")
  expect(JSON.stringify(options.queryKey)).not.toContain("mutedIpsVersion")
  await options.queryFn()
  expect(mocks.fetchTopAsns.mock.calls[0][0].excludeMutedIps).toBeUndefined()
})

it("keys and sends the flag on Access Logs only when given a flagged scope", async () => {
  useAccessLogs({ muted: flagged })
  const flaggedOptions = mocks.options.at(-1)!
  expect(JSON.stringify(flaggedOptions.queryKey)).toContain(
    '"excludeMutedIps":true,"mutedIpsVersion":"abc12345"',
  )
  await flaggedOptions.queryFn()
  expect(mocks.fetchAccessLogs).toHaveBeenCalledWith(
    expect.objectContaining({ excludeMutedIps: true }),
  )
  useAccessLogs()
  expect(JSON.stringify(mocks.options.at(-1)!.queryKey)).not.toContain("excludeMutedIps")
})

it("shares one key between the Geo Logs chart and its sparklines", () => {
  useGeoLogTimeSeries()
  useGeoLogSparklines()
  const [chart, sparklines] = mocks.options
  expect(sparklines.queryKey).toEqual(chart.queryKey)
})

it("does not carry a placeholder across a version change", () => {
  useAccessLogs({ muted: flagged })
  const placeholder = mocks.options.at(-1)!.placeholderData as (
    previous: unknown,
    previousQuery: { queryKey: unknown[] },
  ) => unknown
  const previousQuery = {
    queryKey: ["x", { excludeMutedIps: true, mutedIpsVersion: "other000" }],
  }
  expect(placeholder("rows", previousQuery)).toBeUndefined()
  expect(
    placeholder("rows", {
      queryKey: ["x", { excludeMutedIps: true, mutedIpsVersion: "abc12345" }],
    }),
  ).toBe("rows")
})

it("resets the page only on a user flip of the switch", () => {
  const setHidden = vi.fn()
  const patchSearch = vi.fn()
  makeToggleMuted(true, setHidden, patchSearch)()
  expect(setHidden).toHaveBeenCalledWith(false)
  expect(patchSearch).toHaveBeenCalledWith({ page: undefined })
})

it("only clamps down to the last page when the list version changes", () => {
  const patchSearch = vi.fn()
  // A version change reaches the tables as a smaller page count; the table moves
  // to the last page and never touches the switch's page-reset path.
  const target = pageToClamp({ loaded: true, placeholder: false, page: 5, pageCount: 2 })
  expect(target).toBe(2)
  expect(patchSearch).not.toHaveBeenCalled()
  expect(pageToClamp({ loaded: true, placeholder: true, page: 5, pageCount: 2 })).toBeNull()
  expect(pageToClamp({ loaded: false, placeholder: false, page: 5, pageCount: 2 })).toBeNull()
  expect(pageToClamp({ loaded: true, placeholder: false, page: 2, pageCount: 2 })).toBeNull()
})
