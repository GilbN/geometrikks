/**
 * Tooltip content for the time-series charts.
 *
 * `ChartTooltipContent` renders its label verbatim when no `labelFormatter` is
 * given, which meant tooltip headers showed the raw UTC ISO string while the
 * axis ticks were browser-local. This wrapper defaults the label to `formatTs`,
 * the same function the axes use. It also shows raw values for rows floored
 * for a log axis.
 */
import type * as React from "react"
import { ChartTooltipContent } from "@/components/ui/chart"
import { withRawValues } from "@/lib/chart-tooltip"
import { formatTs } from "@/lib/datetime"

type ContentProps = React.ComponentProps<typeof ChartTooltipContent>

export function TimeSeriesTooltip({
  granularity,
  payload,
  ...props
}: ContentProps & {
  /** Bucket size from the time-series response; picks day+hour vs day. */
  granularity?: string
}) {
  return (
    <ChartTooltipContent
      labelFormatter={(value) => formatTs(value as string, granularity)}
      payload={withRawValues(payload)}
      {...props}
    />
  )
}
