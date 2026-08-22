/**
 * Time-series chart for the geo-logs page: bucketed geo-event totals and
 * unique IPs, honoring the shared filter set and the global time range.
 */
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { formatNumber } from "@/lib/api"
import { clampedYMax } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useGeoLogTimeSeries } from "@/lib/queries"
import { TimeSeriesTooltip } from "@/components/analytics/time-series-tooltip"

const chartConfig = {
  totalEvents: { label: "Events", color: "var(--chart-1)" },
  uniqueIps: { label: "Unique IPs", color: "var(--chart-2)" },
} satisfies ChartConfig

export function GeoLogsChart() {
  const { data, isLoading } = useGeoLogTimeSeries()
  const clipMax = clampedYMax(
    (data?.data ?? []).flatMap((d) => [d.totalEvents, d.uniqueIps]),
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Geo Events Over Time</CardTitle>
        {clipMax != null && (
          <CardAction className="text-xs text-muted-foreground">
            y-axis clipped at {formatNumber(clipMax)}
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-[280px] w-full" />
        ) : (
          <ChartContainer config={chartConfig} className="h-[280px] w-full">
            <AreaChart data={data.data}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="timestamp"
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: string) => formatTs(v, data.granularity)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={(v: number) => formatNumber(v)}
                domain={clipMax != null ? [0, clipMax] : undefined}
                allowDataOverflow={clipMax != null}
              />
              <ChartTooltip content={<TimeSeriesTooltip granularity={data.granularity} />} />
              <Area
                dataKey="totalEvents"
                type="monotone"
                fill="var(--color-totalEvents)"
                fillOpacity={0.2}
                stroke="var(--color-totalEvents)"
                strokeWidth={2}
              />
              <Area
                dataKey="uniqueIps"
                type="monotone"
                fill="var(--color-uniqueIps)"
                fillOpacity={0.2}
                stroke="var(--color-uniqueIps)"
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
