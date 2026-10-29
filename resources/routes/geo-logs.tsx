/**
 * Geo Logs route: geo events grouped by (location, IP) with an embedded map,
 * stat cards, time-series chart, top-10 lists and a paginated table, all
 * honoring one shared filter set.
 *
 * The filter/pagination state lives in the URL search params so filtered
 * views are shareable links; the search schema and the codec that maps it to
 * GeoLogFiltersContext live in lib/geo-logs-search.ts. The date range stays
 * global via TimeRangeProvider and is deliberately not in the URL.
 */
import { lazy, Suspense } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@/components/page-header"
import { JumpBar, JumpTarget, type JumpSection } from "@/components/jump-bar"
import { SignalPanel } from "@/components/data/signal-panel"
import { GeoLogsFilterBar } from "@/components/geo-logs/geo-logs-filter-bar"
import { GeoLogsStats } from "@/components/geo-logs/geo-logs-stats"
import { GeoLogsChart } from "@/components/geo-logs/geo-logs-chart"
import { GeoTopIpsTable } from "@/components/geo-logs/geo-top-ips-table"
import { GeoTopCountriesCities } from "@/components/geo-logs/geo-top-countries-cities"
import { GeoLogsTable } from "@/components/geo-logs/geo-logs-table"
import { GeoLogFiltersProvider } from "@/lib/geo-log-filters-context"
import { useUrlFilters } from "@/hooks/use-url-filters"
import { dropDefault } from "@/lib/url-filters"
import {
  decodeGeoLogsSearch,
  encodeGeoLogFilters,
  GEO_LOGS_RESET_ON_CHANGE,
  geoLogsSearchSchema,
  type GeoLogsSearch,
} from "@/lib/geo-logs-search"
import { useCrowdsecLiveUpdates } from "@/lib/queries"
import type { GeoLogSortField, GeoLogSortOrder } from "@/lib/api"

const GeoLogsMap = lazy(() => import("@/components/geo-logs/geo-logs-map"))

export const Route = createFileRoute("/geo-logs")({
  validateSearch: (search: Record<string, unknown>): GeoLogsSearch =>
    geoLogsSearchSchema.parse(search),
  component: GeoLogsPage,
})

const SECTIONS: readonly JumpSection[] = [
  { id: "map", label: "Map" },
  { id: "over-time", label: "Over time" },
  { id: "top-ips", label: "Top IPs" },
  { id: "locations", label: "Locations" },
  { id: "events", label: "Events" },
]

function GeoLogsPage() {
  const search = Route.useSearch({
    select: ({ inspect: _inspect, ...routeSearch }) => routeSearch,
    structuralSharing: true,
  })
  const navigate = Route.useNavigate()
  // Keep banned badges (Top IPs card + geo-logs table) in sync with external
  // cscli/console decisions; one subscription for the whole page.
  useCrowdsecLiveUpdates()

  const { filters, setFilters, patchSearch } = useUrlFilters({
    search,
    navigate,
    decode: decodeGeoLogsSearch,
    encode: encodeGeoLogFilters,
    resetOnChange: GEO_LOGS_RESET_ON_CHANGE,
  })

  const page = search.page ?? 1
  const pageSize = search.pageSize ?? 50
  const sortBy: GeoLogSortField = search.sortBy ?? "eventCount"
  const sort: GeoLogSortOrder = search.sort ?? "desc"

  return (
    <GeoLogFiltersProvider filters={filters} setFilters={setFilters}>
      <div className="p-4 space-y-4">
        <PageHeader
          title="Geo Logs"
          subtitle="Trace where traffic originates, how locations change over time, and which clients recur."
        />
        <JumpBar sections={SECTIONS} />
        <GeoLogsFilterBar />
        <GeoLogsStats />
        <div className="grid gap-4 lg:grid-cols-2">
          <JumpTarget id="map">
            <Suspense
              fallback={
                <SignalPanel
                  title="Spatial preview"
                  description="Request locations in the selected range."
                  state="loading"
                  bodyClassName="min-h-[320px]"
                />
              }
            >
              <GeoLogsMap />
            </Suspense>
          </JumpTarget>
          <JumpTarget id="over-time"><GeoLogsChart /></JumpTarget>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <JumpTarget id="top-ips"><GeoTopIpsTable /></JumpTarget>
          <JumpTarget id="locations"><GeoTopCountriesCities /></JumpTarget>
        </div>
        <JumpTarget id="events">
          <GeoLogsTable
            page={page}
            pageSize={pageSize}
            sortField={sortBy}
            sortOrder={sort}
            onPageChange={(next) => patchSearch({ page: dropDefault(next, 1) })}
            onPageSizeChange={(next) =>
              patchSearch({ pageSize: dropDefault(next, 50), page: undefined })
            }
            onSortChange={(nextField, nextOrder) =>
              patchSearch({
                sortBy: dropDefault(nextField, "eventCount"),
                sort: dropDefault(nextOrder, "desc"),
                page: undefined,
              })
            }
          />
        </JumpTarget>
      </div>
    </GeoLogFiltersProvider>
  )
}
