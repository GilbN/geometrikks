import { TooltipProvider } from "@/components/ui/tooltip"
import { Card, CardContent } from "@/components/ui/card"

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
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Summary</h1>

            {summary && (
              <DateTimeRange start={summary.startDate} end={summary.endDate} />
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Overview of live analytics data for your application.
          </p>
        </div>

        {isError && (
          <Card className="border-destructive/50 bg-destructive/10">
            <CardContent className="pt-6">
              <p className="text-sm text-destructive">
                Failed to load analytics data: {error?.message ?? "Unknown error"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Make sure the backend server is running on port 8000.
              </p>
            </CardContent>
          </Card>
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
