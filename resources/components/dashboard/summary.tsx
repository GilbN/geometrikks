import { TooltipProvider } from "@/components/ui/tooltip"

import { useSummary } from "@/lib/queries"
import { TIME_RANGE_PRESETS } from "@/lib/api"
import { useTimeRange } from "@/lib/time-range-context"
import { DateTimeRange } from "@/components/dashboard/date-time-range"
import {
  HttpStatusSection,
  PerformanceSection,
  TrafficOverviewSection,
} from "@/components/dashboard/summary-sections"
import { TrafficOriginStats } from "@/components/dashboard/traffic-origin-stats"
import { PageHeader } from "@/components/page-header"
import { ErrorBanner } from "@/components/error-banner"

export function Summary() {
  const { range } = useTimeRange()
  const { data: summary, isLoading, isError, error } = useSummary({
    comparePrevious: true,
  })

  const rangeLabel =
    TIME_RANGE_PRESETS.find((p) => p.value === range)?.label ?? range
  const section = { summary, isLoading, rangeLabel }

  return (
    <TooltipProvider>
      <div className="p-4 md:p-6 space-y-6">
        <PageHeader
          title="Summary"
          subtitle="Overview of live analytics data for your application."
          meta={
            summary && (
              <DateTimeRange start={summary.startDate} end={summary.endDate} />
            )
          }
        />

        {isError && (
          <ErrorBanner
            title={`Failed to load analytics data: ${error?.message ?? "Unknown error"}`}
            detail="Make sure the backend server is running on port 8000."
          />
        )}

        {/* Every section renders its own skeletons in place, so this order
            is the order on screen in both the loading and loaded states.
            Traffic Origin has its own query and its own states; it is not
            gated on /summary so its request starts with the others. */}
        <TrafficOverviewSection {...section} />
        <TrafficOriginStats />
        <HttpStatusSection {...section} />
        <PerformanceSection {...section} />
      </div>
    </TooltipProvider>
  )
}
