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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/page-header"
import { AccessLogsTable } from "@/components/access-logs/access-logs-table"
import { AccessLogsFilterBar } from "@/components/access-logs/access-logs-filter-bar"
import { LiveTail } from "@/components/access-logs/live-tail"
import { AccessLogFiltersProvider } from "@/lib/access-log-filters-context"
import {
  ACCESS_LOGS_RESET_ON_CHANGE,
  accessLogsSearchSchema,
  decodeAccessLogsSearch,
  encodeAccessLogFilters,
  type AccessLogsSearch,
} from "@/lib/access-logs-search"
import { useUrlFilters } from "@/hooks/use-url-filters"
import { dropDefault } from "@/lib/url-filters"
import type { AccessLogSortField, SortOrder } from "@/lib/api"

const DEFAULT_PAGE_SIZE = 20
const DEFAULT_SORT: AccessLogSortField = "timestamp"
const DEFAULT_ORDER: SortOrder = "desc"

export const Route = createFileRoute("/access-logs")({
  validateSearch: (search: Record<string, unknown>): AccessLogsSearch =>
    accessLogsSearchSchema.parse(search),
  component: AccessLogsPage,
})

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
    decode: decodeAccessLogsSearch,
    encode: encodeAccessLogFilters,
    resetOnChange: ACCESS_LOGS_RESET_ON_CHANGE,
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
        {/* Below md the filter bar is a single Filters button, so it shares
            the row with the tabs. */}
        <div className="space-y-4 max-md:flex max-md:flex-wrap max-md:items-center max-md:justify-between max-md:gap-3 max-md:space-y-0">
          <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
            <TabsList>
              <TabsTrigger value="history">
                <History className="h-4 w-4" /> History
              </TabsTrigger>
              <TabsTrigger value="live">
                <Radio className="h-4 w-4" /> Live tail
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {mode === "history" && <AccessLogsFilterBar />}
        </div>
        {mode === "history" ? (
          <>
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
