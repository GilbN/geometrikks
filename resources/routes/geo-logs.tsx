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
import { lazy, Suspense } from "react"
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
import { useUrlFilters } from "@/hooks/use-url-filters"
import { arrayParam, dropDefault } from "@/lib/url-filters"
import { useCrowdsecLiveUpdates } from "@/lib/queries"
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

// Module-level so their identity is stable across renders.
function decode(search: GeoLogsSearch): GeoLogFilterState {
  return {
    countryCodes: search.country ?? [],
    cities: search.city ?? [],
    ips: search.ip ?? [],
    ipsExclude: search.ipx ?? [],
    hostnames: search.host ?? [],
  }
}

function encode(filters: GeoLogFilterState): Partial<GeoLogsSearch> {
  return {
    country: arrayParam(filters.countryCodes),
    city: arrayParam(filters.cities),
    ip: arrayParam(filters.ips),
    ipx: arrayParam(filters.ipsExclude),
    host: arrayParam(filters.hostnames),
  }
}

// Filter changes always return to page 1.
const RESET_ON_CHANGE: Partial<GeoLogsSearch> = { page: undefined }

function GeoLogsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  // Keep banned badges (Top IPs card + geo-logs table) in sync with external
  // cscli/console decisions; one subscription for the whole page.
  useCrowdsecLiveUpdates()

  const { filters, setFilters, patchSearch } = useUrlFilters({
    search,
    navigate,
    decode,
    encode,
    resetOnChange: RESET_ON_CHANGE,
  })

  const page = search.page ?? 1
  const pageSize = search.pageSize ?? 50
  const sort: GeoLogSortOrder = search.sort ?? "desc"

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
          onPageChange={(next) => patchSearch({ page: dropDefault(next, 1) })}
          onPageSizeChange={(next) =>
            patchSearch({ pageSize: dropDefault(next, 50), page: undefined })
          }
          onSortOrderChange={(next) =>
            patchSearch({ sort: dropDefault(next, "desc"), page: undefined })
          }
        />
      </div>
    </GeoLogFiltersProvider>
  )
}
