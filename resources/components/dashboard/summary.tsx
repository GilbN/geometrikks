import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"

import { useSummary } from "@/lib/queries"
import { rangeCompareLabel, rangeSubtitle } from "@/lib/time-range-labels"
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

  const section = {
    summary,
    isLoading,
    rangeSubtitle: rangeSubtitle(range),
    compareLabel: rangeCompareLabel(range),
  }

  return (
    <TooltipProvider>
      <div className="p-4 md:p-6 space-y-6">
        <PageHeader
          title="Overview"
          subtitle="Traffic, status codes and response times for the selected range."
          meta={
            summary ? (
              <DateTimeRange start={summary.startDate} end={summary.endDate} />
            ) : (
              // Holds the band's place while loading. Below md it is all the
              // header shows, and without it the page jumps on every refresh.
              !isError && <Skeleton className="h-6 w-72 max-w-full rounded-md" />
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
