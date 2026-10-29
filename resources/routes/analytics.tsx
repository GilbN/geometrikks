/**
 * Analytics route: charts and top-lists over the access-log data, all
 * reshaped by one shared filter set.
 *
 * The filter state lives in the URL search params so filtered views are
 * shareable links; this route validates the params (zod, with .catch()
 * fallbacks so mangled URLs degrade to defaults instead of erroring) and
 * feeds them to AnalyticsFiltersContext. The date range stays global via
 * TimeRangeProvider and is deliberately not in the URL, as on geo-logs.
 */
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { PageHeader } from "@/components/page-header"
import { SectionHeader } from "@/components/section-header"
import { JumpBar, JumpTarget, type JumpSection } from "@/components/jump-bar"
import { RequestsChart } from "@/components/analytics/requests-chart"
import { StatusChart } from "@/components/analytics/status-chart"
import { BytesChart } from "@/components/analytics/bytes-chart"
import { LatencyChart } from "@/components/analytics/latency-chart"
import { TopUrlsTable } from "@/components/analytics/top-urls-table"
import { TopUserAgentsTable } from "@/components/analytics/top-user-agents-table"
import { TopAsnsTable } from "@/components/analytics/top-asns-table"
import { TrafficOriginCard } from "@/components/analytics/traffic-origin-card"
import { TopIpsTable } from "@/components/analytics/top-ips-table"
import { TopCountriesCities } from "@/components/analytics/top-countries-cities"
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar"
import {
  AnalyticsFiltersProvider,
  type AnalyticsFilterState,
} from "@/lib/analytics-filters-context"
import { useUrlFilters } from "@/hooks/use-url-filters"
import { arrayParam } from "@/lib/url-filters"

// Absent keys mean "default"; navigate() writes undefined for defaults so
// clean states produce clean URLs. Param names match the geo-logs page.
const analyticsSearchSchema = z.object({
  country: z.array(z.string()).optional().catch(undefined),
  city: z.array(z.string()).optional().catch(undefined),
  ip: z.array(z.string()).optional().catch(undefined),
  ipx: z.array(z.string()).optional().catch(undefined),
})

type AnalyticsSearch = z.infer<typeof analyticsSearchSchema>

export const Route = createFileRoute("/analytics")({
  validateSearch: (search: Record<string, unknown>): AnalyticsSearch =>
    analyticsSearchSchema.parse(search),
  staticData: { timeRange: true, chartBuckets: true },
  component: AnalyticsPage,
})

// Module-level so their identity is stable across renders.
function decode(search: AnalyticsSearch): AnalyticsFilterState {
  return {
    countryCodes: search.country ?? [],
    cities: search.city ?? [],
    ips: search.ip ?? [],
    ipsExclude: search.ipx ?? [],
  }
}

function encode(filters: AnalyticsFilterState): Partial<AnalyticsSearch> {
  return {
    country: arrayParam(filters.countryCodes),
    city: arrayParam(filters.cities),
    ip: arrayParam(filters.ips),
    ipx: arrayParam(filters.ipsExclude),
  }
}

const SECTIONS: readonly JumpSection[] = [
  { id: "requests", label: "Requests" },
  { id: "status", label: "Status" },
  { id: "bandwidth", label: "Bandwidth" },
  { id: "latency", label: "Latency" },
  { id: "top-ips", label: "Top IPs" },
  { id: "locations", label: "Locations" },
  { id: "urls", label: "URLs" },
  { id: "user-agents", label: "User agents" },
  { id: "origin", label: "Origin" },
  { id: "asns", label: "ASNs" },
]

function AnalyticsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  // No pagination on this page, so nothing to reset on a filter change.
  const { filters, setFilters } = useUrlFilters({ search, navigate, decode, encode })

  return (
    <AnalyticsFiltersProvider filters={filters} setFilters={setFilters}>
      <div className="p-4 space-y-4">
        <PageHeader
          title="Analytics"
          subtitle="Inspect request volume, delivery health, and the clients driving traffic."
        />
        <JumpBar sections={SECTIONS} />
        <AnalyticsFilterBar />
        <SectionHeader>Traffic</SectionHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <JumpTarget id="requests"><RequestsChart /></JumpTarget>
          <JumpTarget id="status"><StatusChart /></JumpTarget>
          <JumpTarget id="bandwidth"><BytesChart /></JumpTarget>
          <JumpTarget id="latency"><LatencyChart /></JumpTarget>
        </div>
        <SectionHeader>Top Lists</SectionHeader>
        <div className="grid gap-4 lg:grid-cols-2">
          <JumpTarget id="top-ips"><TopIpsTable /></JumpTarget>
          <JumpTarget id="locations"><TopCountriesCities /></JumpTarget>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <JumpTarget id="urls"><TopUrlsTable /></JumpTarget>
          <JumpTarget id="user-agents"><TopUserAgentsTable /></JumpTarget>
        </div>
        <SectionHeader>Traffic Origin</SectionHeader>
        {/* A grid gap, because space-y margins don't apply to JumpTarget's
            display: contents wrapper. */}
        <div className="grid gap-4">
          <JumpTarget id="origin"><TrafficOriginCard /></JumpTarget>
          <JumpTarget id="asns"><TopAsnsTable /></JumpTarget>
        </div>
      </div>
    </AnalyticsFiltersProvider>
  )
}
