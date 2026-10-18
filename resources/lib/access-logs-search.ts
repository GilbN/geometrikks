/** URL codec for the access-logs page filters, plus the route's search schema.
 *  Pure module: vitest runs without a DOM, so no router imports here. */
import { z } from "zod"
import { ACCESS_LOGS_PAGE_SIZES } from "@/components/access-logs/access-logs-table"
import type { AccessLogFilterState } from "@/lib/access-log-filters-context"
import { arrayParam } from "@/lib/url-filters"

// Absent keys mean "default"; navigate() writes undefined for defaults so
// clean states produce clean URLs.
export const accessLogsSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  ip: z.array(z.string()).optional().catch(undefined),
  ipx: z.array(z.string()).optional().catch(undefined),
  host: z.array(z.string()).optional().catch(undefined),
  hostx: z.array(z.string()).optional().catch(undefined),
  server: z.array(z.string()).optional().catch(undefined),
  serverx: z.array(z.string()).optional().catch(undefined),
  logFormat: z.array(z.string()).optional().catch(undefined),
  country: z.array(z.string()).optional().catch(undefined),
  city: z.array(z.string()).optional().catch(undefined),
  method: z.array(z.string()).optional().catch(undefined),
  status: z.array(z.number().int()).optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
  pageSize: z
    .number()
    .refine((v) =>
      ACCESS_LOGS_PAGE_SIZES.includes(v as (typeof ACCESS_LOGS_PAGE_SIZES)[number]),
    )
    .optional()
    .catch(undefined),
  sort: z
    .enum([
      "timestamp", "statusCode", "bytesSent", "requestTime",
      "method", "ipAddress", "host", "url",
    ])
    .optional()
    .catch(undefined),
  order: z.enum(["asc", "desc"]).optional().catch(undefined),
})

export type AccessLogsSearch = z.infer<typeof accessLogsSearchSchema>

// Module-level so their identity is stable across renders (useUrlFilters
// memoizes on them).
export function decodeAccessLogsSearch(search: AccessLogsSearch): AccessLogFilterState {
  return {
    search: search.q ?? "",
    ips: search.ip ?? [],
    ipsExclude: search.ipx ?? [],
    hosts: search.host ?? [],
    hostsExclude: search.hostx ?? [],
    servers: search.server ?? [],
    serversExclude: search.serverx ?? [],
    logFormats: search.logFormat ?? [],
    methods: search.method ?? [],
    statusCodes: search.status ?? [],
    cities: search.city ?? [],
    countryCodes: search.country ?? [],
  }
}

export function encodeAccessLogFilters(filters: AccessLogFilterState): Partial<AccessLogsSearch> {
  return {
    q: filters.search || undefined,
    ip: arrayParam(filters.ips),
    ipx: arrayParam(filters.ipsExclude),
    host: arrayParam(filters.hosts),
    hostx: arrayParam(filters.hostsExclude),
    server: arrayParam(filters.servers),
    serverx: arrayParam(filters.serversExclude),
    logFormat: arrayParam(filters.logFormats),
    country: arrayParam(filters.countryCodes),
    city: arrayParam(filters.cities),
    method: arrayParam(filters.methods),
    status: arrayParam(filters.statusCodes),
  }
}

/** Filter changes always return to page 1. */
export const ACCESS_LOGS_RESET_ON_CHANGE: Partial<AccessLogsSearch> = { page: undefined }
