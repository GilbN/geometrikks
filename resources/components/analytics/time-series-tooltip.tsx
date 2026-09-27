/**
 * Tooltip content for the time-series charts.
 *
 * `ChartTooltipContent` renders its label verbatim when no `labelFormatter` is
 * given, which meant tooltip headers showed the raw UTC ISO string while the
 * axis ticks were browser-local. This wrapper defaults the label to `formatTs`,
 * the same function the axes use. It also shows raw values for rows floored
 * for a log axis, and lets a view replace the rows entirely (`rows`).
 */
import type * as React from "react"
import { ChartTooltipContent } from "@/components/ui/chart"
import { withRawValues, type TooltipRow } from "@/lib/chart-tooltip"
import { formatTs } from "@/lib/datetime"

type ContentProps = React.ComponentProps<typeof ChartTooltipContent>
type PayloadItems = NonNullable<ContentProps["payload"]>

export function TimeSeriesTooltip({
  granularity,
  payload,
  rows,
  ...props
}: ContentProps & {
  /** Bucket size from the time-series response; picks day+hour vs day. */
  granularity?: string
  /** Builds the rows from the hovered data row instead of the Recharts payload. */
  rows?: (row: unknown) => TooltipRow[]
}) {
  const items = rows && payload?.length
    ? (rows(payload[0].payload) as unknown as PayloadItems)
    : withRawValues(payload)
  return (
    <ChartTooltipContent
      labelFormatter={(value) => formatTs(value as string, granularity)}
      payload={items}
      {...props}
    />
  )
}
