/**
 * Stat cards for the debug-logs page: total captured lines, malformed count
 * with share of total, and the most common parse error, all scoped to the
 * selected time range.
 */
import { AlertTriangle, Bug, ScrollText } from "lucide-react"
import { StatCard, StatCardSkeleton } from "@/components/dashboard/statcard"
import { ErrorBanner } from "@/components/error-banner"
import { formatNumber, formatPercent, TIME_RANGE_PRESETS } from "@/lib/api"
import { useAccessLogDebugStats } from "@/lib/queries"
import { useTimeRange } from "@/lib/time-range-context"

export function DebugLogsStats() {
  const { range } = useTimeRange()
  const { data, isLoading, isError } = useAccessLogDebugStats()

  const rangeLabel = TIME_RANGE_PRESETS.find((p) => p.value === range)?.label ?? range

  if (isError) {
    return <ErrorBanner title="Failed to load debug log stats." />
  }

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
    )
  }

  const malformedShare =
    data.total > 0 ? formatPercent((data.malformed / data.total) * 100) : null

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <StatCard
        title="Debug Lines"
        value={formatNumber(data.total)}
        subtitle={`Last ${rangeLabel}`}
        icon={ScrollText}
      />
      <StatCard
        title="Malformed"
        value={formatNumber(data.malformed)}
        subtitle={malformedShare ? `${malformedShare} of total` : `Last ${rangeLabel}`}
        icon={AlertTriangle}
        iconClassName="text-amber-500"
      />
      <StatCard
        title="Top Parse Error"
        value={data.topParseError?.error ?? "None"}
        valueClassName="truncate text-lg"
        subtitle={
          data.topParseError
            ? `${formatNumber(data.topParseError.count)} lines`
            : `Last ${rangeLabel}`
        }
        icon={Bug}
      />
    </div>
  )
}
