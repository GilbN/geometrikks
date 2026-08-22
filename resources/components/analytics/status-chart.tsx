import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { formatNumber } from "@/lib/api"
import { clampedYMax } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { TimeSeriesTooltip } from "./time-series-tooltip"

// Slot order matches the stack order: adjacent-pair CVD separation of the
// palette is only guaranteed for slots used in sequence.
const chartConfig = {
  status2xx: { label: "2xx", color: "var(--chart-1)" },
  status3xx: { label: "3xx", color: "var(--chart-2)" },
  status4xx: { label: "4xx", color: "var(--chart-3)" },
  status5xx: { label: "5xx", color: "var(--chart-4)" },
} satisfies ChartConfig

const STATUS_KEYS = Object.keys(chartConfig) as (keyof typeof chartConfig)[]

// Above this many buckets the per-bar surface spacers are wider than the bars
// themselves (the card-colored strokes erase the fill entirely on 7d+ hourly
// views), so the stack switches to areas, which have no per-mark spacer.
const DENSE_BUCKETS = 48

export function StatusChart() {
  const { data, isLoading } = useTimeSeries()
  const buckets = data?.data ?? []
  const dense = buckets.length > DENSE_BUCKETS
  const clipMax = clampedYMax(
    buckets.map((d) => STATUS_KEYS.reduce((sum, key) => sum + (d[key] ?? 0), 0)),
  )
  const SeriesChart = dense ? AreaChart : BarChart

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Status classes</CardTitle>
        {clipMax != null && (
          <CardAction className="text-xs text-muted-foreground">
            y-axis clipped at {formatNumber(clipMax)}
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-[240px] w-full" />
        ) : (
          <ChartContainer config={chartConfig} className="h-[240px] w-full">
            <SeriesChart data={data.data}>
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
              <ChartLegend content={<ChartLegendContent />} />
              {STATUS_KEYS.map((key, i) =>
                dense ? (
                  <Area
                    key={key}
                    dataKey={key}
                    stackId="s"
                    type="monotone"
                    fill={`var(--color-${key})`}
                    fillOpacity={1}
                    stroke="none"
                  />
                ) : (
                  // stroke = card surface: the 2px spacer between stacked segments
                  <Bar
                    key={key}
                    dataKey={key}
                    stackId="s"
                    fill={`var(--color-${key})`}
                    stroke="var(--card)"
                    strokeWidth={1}
                    radius={i === STATUS_KEYS.length - 1 ? [2, 2, 0, 0] : undefined}
                  />
                ),
              )}
            </SeriesChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
