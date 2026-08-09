/**
 * Tooltip content for the time-series charts.
 *
 * `ChartTooltipContent` renders its label verbatim when no `labelFormatter` is
 * given, which meant tooltip headers showed the raw UTC ISO string while the
 * axis ticks were browser-local. This wrapper defaults the label to `formatTs`,
 * the same function the axes use.
 */
import type * as React from "react"
import { ChartTooltipContent } from "@/components/ui/chart"
import { formatTs } from "@/lib/datetime"

export function TimeSeriesTooltip({
  granularity,
  ...props
}: React.ComponentProps<typeof ChartTooltipContent> & {
  /** Bucket size from the time-series response; picks day+hour vs day. */
  granularity?: string
}) {
  return (
    <ChartTooltipContent
      labelFormatter={(value) => formatTs(value as string, granularity)}
      {...props}
    />
  )
}
