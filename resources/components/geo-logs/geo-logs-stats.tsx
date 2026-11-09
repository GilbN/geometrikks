/**
 * Stat cards for the geo-logs page: totals and uniques for the selected time
 * range and filters, with percent-change trends vs the previous period and a
 * chart of each figure across the range.
 */
import { Activity, Building2, Globe2, Users } from "lucide-react"
import { StatCard, StatCardSkeleton, StatGrid, sparklineProps } from "@/components/dashboard/statcard"
import { ErrorBanner } from "@/components/error-banner"
import { formatNumber } from "@/lib/api"
import { useCardCharts } from "@/lib/card-charts"
import { useGeoLogSparklines, useGeoLogSummary } from "@/lib/queries"
import { useTimeRange } from "@/lib/time-range-context"
import { rangeSubtitle } from "@/lib/time-range-labels"

export function GeoLogsStats() {
  const { range } = useTimeRange()
  const { data: summary, isLoading, isError } = useGeoLogSummary({ comparePrevious: true })
  const [chartsOn] = useCardCharts("geo-logs")
  const sparklines = useGeoLogSparklines({ enabled: chartsOn })

  const subtitle = rangeSubtitle(range)

  if (isError) {
    return <ErrorBanner title="Failed to load geo event summary." />
  }

  if (isLoading || !summary) {
    return (
      <StatGrid className="lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <StatCardSkeleton key={i} sparkline={sparklines.shown} />)}
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
        {...sparklineProps(sparklines, "events")}
      />
      <StatCard
        title="Unique IPs"
        value={formatNumber(summary.currentPeriod.uniqueIps)}
        subtitle={subtitle}
        icon={Users}
        trend={{ value: changes?.uniqueIps ?? null }}
        {...sparklineProps(sparklines, "uniqueIps")}
      />
      <StatCard
        title="Countries"
        value={formatNumber(summary.currentPeriod.uniqueCountries)}
        subtitle={subtitle}
        icon={Globe2}
        trend={{ value: changes?.uniqueCountries ?? null }}
        {...sparklineProps(sparklines, "uniqueCountries")}
      />
      <StatCard
        title="Cities"
        value={formatNumber(summary.currentPeriod.uniqueCities)}
        subtitle={subtitle}
        icon={Building2}
        trend={{ value: changes?.uniqueCities ?? null }}
        {...sparklineProps(sparklines, "uniqueCities")}
      />
    </StatGrid>
  )
}
