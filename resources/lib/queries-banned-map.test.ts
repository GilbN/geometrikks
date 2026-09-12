import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  options: [] as Array<{ queryKey: unknown[]; queryFn: () => unknown; enabled: boolean }>,
  enabled: true,
  get: vi.fn().mockResolvedValue({ data: { type: "FeatureCollection", features: [] } }),
}))
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: typeof mocks.options[number]) => { mocks.options.push(options); return { data: { enabled: mocks.enabled } } },
  useMutation: vi.fn(), useQueryClient: vi.fn(),
}))
vi.mock("./time-range-context", () => ({ useTimeRange: () => ({ range: "24h", customRange: null, lastRefresh: 123 }) }))
import { api } from "./api"
import { useBannedLocations } from "./queries"

beforeEach(() => {
  mocks.options = []
  mocks.enabled = true
  vi.spyOn(api, "get").mockImplementation(mocks.get)
})
it("keys and forwards all filters", async () => {
  const filters = { countryCodes: ["NO", "SE"], cities: ["Oslo"], hostnames: ["a.test", "b.test"] }
  useBannedLocations(true, filters)
  const options = mocks.options.at(-1)!
  expect(options.queryKey).toEqual(["crowdsec", "banned-locations", { range: "24h", customRange: null, ...filters }, 123])
  await options.queryFn()
  expect(mocks.get).toHaveBeenCalledWith("/crowdsec/banned-locations", {
    params: { fromTimestamp: expect.any(String), toTimestamp: expect.any(String), countryCode: filters.countryCodes, city: filters.cities, hostnameIn: filters.hostnames },
  })
})
it("only fetches in the active mode with CrowdSec enabled", () => {
  useBannedLocations(false)
  expect(mocks.options.at(-1)?.enabled).toBe(false)
  mocks.enabled = false
  useBannedLocations(true)
  expect(mocks.options.at(-1)?.enabled).toBe(false)
})
