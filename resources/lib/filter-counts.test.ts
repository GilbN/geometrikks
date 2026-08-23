import { describe, expect, it } from "vitest"

import { countActiveAccessLogFilters, EMPTY_ACCESS_LOG_FILTERS } from "./access-log-filters-context"
import { countActiveAnalyticsFilters, EMPTY_FILTERS } from "./analytics-filters-context"
import { countActiveGeoLogFilters, EMPTY_GEO_LOG_FILTERS } from "./geo-log-filters-context"

/** One group is one count, however many values it holds; chips never
 * multiply the badge. */
describe("active filter group counts", () => {
  it("access logs", () => {
    expect(countActiveAccessLogFilters(EMPTY_ACCESS_LOG_FILTERS)).toBe(0)
    expect(
      countActiveAccessLogFilters({
        ...EMPTY_ACCESS_LOG_FILTERS,
        search: "robots",
        ips: ["192.0.2.1", "192.0.2.2", "192.0.2.3"],
        statusCodes: [404, 500],
      }),
    ).toBe(3)
  })

  it("geo logs", () => {
    expect(countActiveGeoLogFilters(EMPTY_GEO_LOG_FILTERS)).toBe(0)
    expect(
      countActiveGeoLogFilters({
        ...EMPTY_GEO_LOG_FILTERS,
        countryCodes: ["NO", "SE", "DK"],
        hostnames: ["edge-01"],
      }),
    ).toBe(2)
  })

  it("analytics", () => {
    expect(countActiveAnalyticsFilters(EMPTY_FILTERS)).toBe(0)
    expect(
      countActiveAnalyticsFilters({
        ...EMPTY_FILTERS,
        cities: ["Oslo", "Bergen"],
        ipsExclude: ["198.51.100.8"],
      }),
    ).toBe(2)
  })
})
