/**
 * Geo Logs route: geo events grouped by (location, IP) with an embedded map,
 * stat cards, time-series chart, top-10 lists and a paginated table, all
 * honoring one shared filter set.
 *
 * The filter/pagination state lives in the URL search params so filtered
 * views are shareable links; this route validates the params (zod, with
 * .catch() fallbacks so mangled URLs degrade to defaults instead of erroring)
 * and feeds them to GeoLogFiltersContext. The date range stays global via
 * TimeRangeProvider and is deliberately not in the URL.
 */
import { lazy, Suspense, useCallback, useMemo } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { GeoLogsFilterBar } from "@/components/geo-logs/geo-logs-filter-bar"
import { GeoLogsStats } from "@/components/geo-logs/geo-logs-stats"
import { GeoLogsChart } from "@/components/geo-logs/geo-logs-chart"
import { GeoTopIpsTable } from "@/components/geo-logs/geo-top-ips-table"
import { GeoTopCountriesCities } from "@/components/geo-logs/geo-top-countries-cities"
import { GeoLogsTable, GEO_LOGS_PAGE_SIZES } from "@/components/geo-logs/geo-logs-table"
import {
  GeoLogFiltersProvider,
  type GeoLogFilterState,
} from "@/lib/geo-log-filters-context"
import type { GeoLogSortOrder } from "@/lib/api"

const GeoLogsMap = lazy(() => import("@/components/geo-logs/geo-logs-map"))

// Absent keys mean "default"; navigate() writes undefined for defaults so
// clean states produce clean URLs.
const geoLogsSearchSchema = z.object({
  country: z.array(z.string()).optional().catch(undefined),
  city: z.array(z.string()).optional().catch(undefined),
  ip: z.array(z.string()).optional().catch(undefined),
  ipx: z.array(z.string()).optional().catch(undefined),
  host: z.array(z.string()).optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
  pageSize: z
    .number()
    .refine((v) => GEO_LOGS_PAGE_SIZES.includes(v as (typeof GEO_LOGS_PAGE_SIZES)[number]))
    .optional()
    .catch(undefined),
  sort: z.enum(["asc", "desc"]).optional().catch(undefined),
})

type GeoLogsSearch = z.infer<typeof geoLogsSearchSchema>

export const Route = createFileRoute("/geo-logs")({
  validateSearch: (search: Record<string, unknown>): GeoLogsSearch =>
    geoLogsSearchSchema.parse(search),
  component: GeoLogsPage,
})

/** Empty arrays and default page/size/sort drop out of the URL entirely. */
function searchFromState(
  filters: GeoLogFilterState,
  table: { page: number; pageSize: number; sort: GeoLogSortOrder },
): GeoLogsSearch {
  return {
    country: filters.countryCodes.length ? filters.countryCodes : undefined,
    city: filters.cities.length ? filters.cities : undefined,
    ip: filters.ips.length ? filters.ips : undefined,
    ipx: filters.ipsExclude.length ? filters.ipsExclude : undefined,
    host: filters.hostnames.length ? filters.hostnames : undefined,
    page: table.page > 1 ? table.page : undefined,
    pageSize: table.pageSize !== 50 ? table.pageSize : undefined,
    sort: table.sort !== "desc" ? table.sort : undefined,
  }
}

function GeoLogsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  const filters = useMemo<GeoLogFilterState>(
    () => ({
      countryCodes: search.country ?? [],
      cities: search.city ?? [],
      ips: search.ip ?? [],
      ipsExclude: search.ipx ?? [],
      hostnames: search.host ?? [],
    }),
    [search.country, search.city, search.ip, search.ipx, search.host],
  )

  const page = search.page ?? 1
  const pageSize = search.pageSize ?? 50
  const sort: GeoLogSortOrder = search.sort ?? "desc"

  // Filter changes reset to page 1; replace:true keeps every tweak from
  // piling up in browser history.
  const setFilters = useCallback(
    (updater: (prev: GeoLogFilterState) => GeoLogFilterState) => {
      navigate({
        search: (prev: GeoLogsSearch) => {
          const current: GeoLogFilterState = {
            countryCodes: prev.country ?? [],
            cities: prev.city ?? [],
            ips: prev.ip ?? [],
            ipsExclude: prev.ipx ?? [],
            hostnames: prev.host ?? [],
          }
          return searchFromState(updater(current), {
            page: 1,
            pageSize: prev.pageSize ?? 50,
            sort: prev.sort ?? "desc",
          })
        },
        replace: true,
      })
    },
    [navigate],
  )

  const setTableState = useCallback(
    (patch: Partial<{ page: number; pageSize: number; sort: GeoLogSortOrder }>) => {
      navigate({
        search: (prev: GeoLogsSearch) => ({
          ...prev,
          page: (patch.page ?? 1) > 1 ? patch.page : undefined,
          pageSize:
            (patch.pageSize ?? prev.pageSize ?? 50) !== 50
              ? (patch.pageSize ?? prev.pageSize)
              : undefined,
          sort:
            (patch.sort ?? prev.sort ?? "desc") !== "desc"
              ? (patch.sort ?? prev.sort)
              : undefined,
        }),
        replace: true,
      })
    },
    [navigate],
  )

  return (
    <GeoLogFiltersProvider filters={filters} setFilters={setFilters}>
      <div className="p-4 space-y-4">
        <GeoLogsFilterBar />
        <GeoLogsStats />
        <div className="grid gap-4 lg:grid-cols-2">
          <Suspense
            fallback={
              <Card className="h-[380px] overflow-hidden py-0">
                <Skeleton className="h-full w-full rounded-none" />
              </Card>
            }
          >
            <GeoLogsMap />
          </Suspense>
          <GeoLogsChart />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <GeoTopIpsTable />
          <GeoTopCountriesCities />
        </div>
        <GeoLogsTable
          page={page}
          pageSize={pageSize}
          sortOrder={sort}
          onPageChange={(next) => setTableState({ page: next })}
          onPageSizeChange={(next) => setTableState({ pageSize: next, page: 1 })}
          onSortOrderChange={(next) => setTableState({ sort: next, page: 1 })}
        />
      </div>
    </GeoLogFiltersProvider>
  )
}
