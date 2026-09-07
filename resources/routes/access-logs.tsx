/**
 * Access Logs route: a History tab with the paginated access-logs table and
 * a Live tail tab.
 *
 * The filter and table state lives in the URL search params so filtered
 * views are shareable links; this route validates the params (zod, with
 * .catch() fallbacks so mangled URLs degrade to defaults instead of
 * erroring) and feeds them to AccessLogFiltersContext. The date range stays
 * global via TimeRangeProvider and is deliberately not in the URL, as on
 * geo-logs. The tab and the visible-column set stay local: a mode and a
 * per-device preference, not part of the shared view.
 */
import { useCallback, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { History, Radio } from "lucide-react"
import { z } from "zod"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/page-header"
import {
  AccessLogsTable,
  ACCESS_LOGS_PAGE_SIZES,
} from "@/components/access-logs/access-logs-table"
import { AccessLogsFilterBar } from "@/components/access-logs/access-logs-filter-bar"
import { LiveTail } from "@/components/access-logs/live-tail"
import {
  AccessLogFiltersProvider,
  type AccessLogFilterState,
} from "@/lib/access-log-filters-context"
import { useUrlFilters } from "@/hooks/use-url-filters"
import { arrayParam, dropDefault } from "@/lib/url-filters"
import type { AccessLogSortField, SortOrder } from "@/lib/api"

const DEFAULT_PAGE_SIZE = 20
const DEFAULT_SORT: AccessLogSortField = "timestamp"
const DEFAULT_ORDER: SortOrder = "desc"

// Absent keys mean "default"; navigate() writes undefined for defaults so
// clean states produce clean URLs.
const accessLogsSearchSchema = z.object({
  q: z.string().optional().catch(undefined),
  ip: z.array(z.string()).optional().catch(undefined),
  ipx: z.array(z.string()).optional().catch(undefined),
  host: z.array(z.string()).optional().catch(undefined),
  hostx: z.array(z.string()).optional().catch(undefined),
  hostname: z.array(z.string()).optional().catch(undefined),
  hostnamex: z.array(z.string()).optional().catch(undefined),
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

type AccessLogsSearch = z.infer<typeof accessLogsSearchSchema>

export const Route = createFileRoute("/access-logs")({
  validateSearch: (search: Record<string, unknown>): AccessLogsSearch =>
    accessLogsSearchSchema.parse(search),
  component: AccessLogsPage,
})

// Module-level so their identity is stable across renders (useUrlFilters
// memoizes on them).
function decode(search: AccessLogsSearch): AccessLogFilterState {
  return {
    search: search.q ?? "",
    ips: search.ip ?? [],
    ipsExclude: search.ipx ?? [],
    hosts: search.host ?? [],
    hostsExclude: search.hostx ?? [],
    hostnames: search.hostname ?? [],
    hostnamesExclude: search.hostnamex ?? [],
    logFormats: search.logFormat ?? [],
    methods: search.method ?? [],
    statusCodes: search.status ?? [],
    cities: search.city ?? [],
    countryCodes: search.country ?? [],
  }
}

function encode(filters: AccessLogFilterState): Partial<AccessLogsSearch> {
  return {
    q: filters.search || undefined,
    ip: arrayParam(filters.ips),
    ipx: arrayParam(filters.ipsExclude),
    host: arrayParam(filters.hosts),
    hostx: arrayParam(filters.hostsExclude),
    hostname: arrayParam(filters.hostnames),
    hostnamex: arrayParam(filters.hostnamesExclude),
    logFormat: arrayParam(filters.logFormats),
    country: arrayParam(filters.countryCodes),
    city: arrayParam(filters.cities),
    method: arrayParam(filters.methods),
    status: arrayParam(filters.statusCodes),
  }
}

// Filter changes always return to page 1.
const RESET_ON_CHANGE: Partial<AccessLogsSearch> = { page: undefined }

type Mode = "history" | "live"

function AccessLogsPage() {
  const search = Route.useSearch({
    select: ({ inspect: _inspect, ...routeSearch }) => routeSearch,
    structuralSharing: true,
  })
  const navigate = Route.useNavigate()
  const [mode, setMode] = useState<Mode>("history")

  const { filters, setFilters, patchSearch } = useUrlFilters({
    search,
    navigate,
    decode,
    encode,
    resetOnChange: RESET_ON_CHANGE,
  })

  const page = search.page ?? 1
  const pageSize = search.pageSize ?? DEFAULT_PAGE_SIZE
  const sortField = search.sort ?? DEFAULT_SORT
  const sortOrder = search.order ?? DEFAULT_ORDER

  const onPageChange = useCallback(
    (next: number) => patchSearch({ page: dropDefault(next, 1) }),
    [patchSearch],
  )
  const onPageSizeChange = useCallback(
    (next: number) =>
      patchSearch({ pageSize: dropDefault(next, DEFAULT_PAGE_SIZE), page: undefined }),
    [patchSearch],
  )
  const onSortChange = useCallback(
    (field: AccessLogSortField, order: SortOrder) =>
      patchSearch({
        sort: dropDefault(field, DEFAULT_SORT),
        order: dropDefault(order, DEFAULT_ORDER),
        page: undefined,
      }),
    [patchSearch],
  )

  return (
    <AccessLogFiltersProvider filters={filters} setFilters={setFilters}>
      <div className="p-4 space-y-4">
        <PageHeader
          title="Access Logs"
          subtitle="Explore request history or follow new traffic as it arrives."
        />
        <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
          <TabsList className="pointer-coarse:h-10">
            <TabsTrigger value="history">
              <History className="h-4 w-4" /> History
            </TabsTrigger>
            <TabsTrigger value="live">
              <Radio className="h-4 w-4" /> Live tail
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {mode === "history" ? (
          <>
            <AccessLogsFilterBar />
            <AccessLogsTable
              page={page}
              pageSize={pageSize}
              sortField={sortField}
              sortOrder={sortOrder}
              onPageChange={onPageChange}
              onPageSizeChange={onPageSizeChange}
              onSortChange={onSortChange}
            />
          </>
        ) : (
          <LiveTail enabled={mode === "live"} />
        )}
      </div>
    </AccessLogFiltersProvider>
  )
}
