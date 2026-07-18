/**
 * Stat cards for the geo-logs page: totals and uniques for the selected time
 * range and filters, with percent-change trends vs the previous period.
 */
import { Activity, Building2, Globe2, Users } from "lucide-react"
import { StatCard, StatCardSkeleton } from "@/components/dashboard/statcard"
import { formatNumber, TIME_RANGE_PRESETS } from "@/lib/api"
import { useGeoLogSummary } from "@/lib/queries"
import { useTimeRange } from "@/lib/time-range-context"

export function GeoLogsStats() {
  const { range } = useTimeRange()
  const { data: summary, isLoading, isError } = useGeoLogSummary({ comparePrevious: true })

  const rangeLabel = TIME_RANGE_PRESETS.find((p) => p.value === range)?.label ?? range

  if (isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load geo event summary.
      </div>
    )
  }

  if (isLoading || !summary) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
    )
  }

  const changes = summary.percentChanges

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Total Events"
        value={formatNumber(summary.currentPeriod.totalEvents)}
        subtitle={`Last ${rangeLabel}`}
        icon={Activity}
        trend={{ value: changes?.totalEvents ?? null }}
      />
      <StatCard
        title="Unique IPs"
        value={formatNumber(summary.currentPeriod.uniqueIps)}
        subtitle={`Last ${rangeLabel}`}
        icon={Users}
        trend={{ value: changes?.uniqueIps ?? null }}
      />
      <StatCard
        title="Countries"
        value={formatNumber(summary.currentPeriod.uniqueCountries)}
        subtitle={`Last ${rangeLabel}`}
        icon={Globe2}
        trend={{ value: changes?.uniqueCountries ?? null }}
      />
      <StatCard
        title="Cities"
        value={formatNumber(summary.currentPeriod.uniqueCities)}
        subtitle={`Last ${rangeLabel}`}
        icon={Building2}
        trend={{ value: changes?.uniqueCities ?? null }}
      />
    </div>
  )
}
