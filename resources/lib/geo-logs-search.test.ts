import { describe, expect, it } from "vitest"

import { EMPTY_GEO_LOG_FILTERS } from "./geo-log-filters-context"
import { decodeGeoLogsSearch, encodeGeoLogFilters, geoLogsSearchSchema } from "./geo-logs-search"

describe("geo-logs search codec", () => {
  it("parses ASN lists as integers", () => {
    const search = geoLogsSearchSchema.parse({ asn: [13335, 24940], asnx: [16509] })
    expect(search.asn).toEqual([13335, 24940])
    expect(search.asnx).toEqual([16509])
  })

  it("drops mangled ASN values instead of throwing", () => {
    expect(geoLogsSearchSchema.parse({ asn: ["x"] }).asn).toBeUndefined()
    expect(geoLogsSearchSchema.parse({ asnx: 13335 }).asnx).toBeUndefined()
    expect(geoLogsSearchSchema.parse({ asn: [1.5] }).asn).toBeUndefined()
  })

  it("round-trips filters through the URL shape", () => {
    const filters = { ...EMPTY_GEO_LOG_FILTERS, ips: ["203.0.113.7"], asns: [13335], asnsExclude: [24940] }
    expect(decodeGeoLogsSearch(encodeGeoLogFilters(filters))).toEqual(filters)
  })

  it("encodes empty lists as absent keys", () => {
    expect(encodeGeoLogFilters(EMPTY_GEO_LOG_FILTERS)).toEqual({
      country: undefined, city: undefined, ip: undefined, ipx: undefined,
      host: undefined, asn: undefined, asnx: undefined,
    })
  })

  it("accepts asn as a sort field", () => {
    expect(geoLogsSearchSchema.parse({ sortBy: "asn" }).sortBy).toBe("asn")
    expect(geoLogsSearchSchema.parse({ sortBy: "asOrganization" }).sortBy).toBeUndefined()
  })
})
