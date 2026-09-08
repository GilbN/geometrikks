/** URL codec for the geo-logs page filters, plus the route's search schema.
 *  Pure module: vitest runs without a DOM, so no router imports here. */
import { z } from "zod"
import { GEO_LOGS_PAGE_SIZES } from "@/components/geo-logs/geo-logs-table"
import type { GeoLogFilterState } from "@/lib/geo-log-filters-context"
import { arrayParam } from "@/lib/url-filters"

// Absent keys mean "default"; navigate() writes undefined for defaults so
// clean states produce clean URLs. .catch() makes mangled URLs degrade to
// defaults instead of erroring.
export const geoLogsSearchSchema = z.object({
  country: z.array(z.string()).optional().catch(undefined),
  city: z.array(z.string()).optional().catch(undefined),
  ip: z.array(z.string()).optional().catch(undefined),
  ipx: z.array(z.string()).optional().catch(undefined),
  host: z.array(z.string()).optional().catch(undefined),
  asn: z.array(z.number().int()).optional().catch(undefined),
  asnx: z.array(z.number().int()).optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
  pageSize: z
    .number()
    .refine((v) => GEO_LOGS_PAGE_SIZES.includes(v as (typeof GEO_LOGS_PAGE_SIZES)[number]))
    .optional()
    .catch(undefined),
  sortBy: z
    .enum([
      "city",
      "postalCode",
      "state",
      "countryCode",
      "countryName",
      "ipAddress",
      "latitude",
      "longitude",
      "eventCount",
      "lastSeen",
      "asn",
    ])
    .optional()
    .catch(undefined),
  sort: z.enum(["asc", "desc"]).optional().catch(undefined),
})

export type GeoLogsSearch = z.infer<typeof geoLogsSearchSchema>

export function decodeGeoLogsSearch(search: GeoLogsSearch): GeoLogFilterState {
  return {
    countryCodes: search.country ?? [],
    cities: search.city ?? [],
    ips: search.ip ?? [],
    ipsExclude: search.ipx ?? [],
    hostnames: search.host ?? [],
    asns: search.asn ?? [],
    asnsExclude: search.asnx ?? [],
  }
}

export function encodeGeoLogFilters(filters: GeoLogFilterState): Partial<GeoLogsSearch> {
  return {
    country: arrayParam(filters.countryCodes),
    city: arrayParam(filters.cities),
    ip: arrayParam(filters.ips),
    ipx: arrayParam(filters.ipsExclude),
    host: arrayParam(filters.hostnames),
    asn: arrayParam(filters.asns),
    asnx: arrayParam(filters.asnsExclude),
  }
}

/** Filter changes always return to page 1. */
export const GEO_LOGS_RESET_ON_CHANGE: Partial<GeoLogsSearch> = { page: undefined }
