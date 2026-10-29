/**
 * Stat cards for the geo-logs page: totals and uniques for the selected time
 * range and filters, with percent-change trends vs the previous period.
 */
import { Activity, Building2, Globe2, Users } from "lucide-react"
import { StatCard, StatCardSkeleton, StatGrid } from "@/components/dashboard/statcard"
import { ErrorBanner } from "@/components/error-banner"
import { formatNumber } from "@/lib/api"
import { useGeoLogSummary } from "@/lib/queries"
import { useTimeRange } from "@/lib/time-range-context"
import { rangeSubtitle } from "@/lib/time-range-labels"

export function GeoLogsStats() {
  const { range } = useTimeRange()
  const { data: summary, isLoading, isError } = useGeoLogSummary({ comparePrevious: true })

  const subtitle = rangeSubtitle(range)

  if (isError) {
    return <ErrorBanner title="Failed to load geo event summary." />
  }

  if (isLoading || !summary) {
    return (
      <StatGrid className="lg:grid-cols-4">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </StatGrid>
    )
  }

  const changes = summary.percentChanges

  return (
    <StatGrid className="lg:grid-cols-4">
      <StatCard
        title="Total Events"
        value={formatNumber(summary.currentPeriod.totalEvents)}
        subtitle={subtitle}
        icon={Activity}
        trend={{ value: changes?.totalEvents ?? null }}
      />
      <StatCard
        title="Unique IPs"
        value={formatNumber(summary.currentPeriod.uniqueIps)}
        subtitle={subtitle}
        icon={Users}
        trend={{ value: changes?.uniqueIps ?? null }}
      />
      <StatCard
        title="Countries"
        value={formatNumber(summary.currentPeriod.uniqueCountries)}
        subtitle={subtitle}
        icon={Globe2}
        trend={{ value: changes?.uniqueCountries ?? null }}
      />
      <StatCard
        title="Cities"
        value={formatNumber(summary.currentPeriod.uniqueCities)}
        subtitle={subtitle}
        icon={Building2}
        trend={{ value: changes?.uniqueCities ?? null }}
      />
    </StatGrid>
  )
}
