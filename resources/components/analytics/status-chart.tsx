import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { formatNumber } from "@/lib/api"
import { clampedYMax } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { ChartLegendRow } from "./chart-legend-row"
import { statusChartConfig } from "./chart-utils"
import { GranularityBadge } from "./granularity-badge"
import { TimeSeriesTooltip } from "./time-series-tooltip"

const STATUS_KEYS = Object.keys(statusChartConfig) as (keyof typeof statusChartConfig)[]

// Above this many buckets the per-bar surface spacers are wider than the bars
// themselves (the card-colored strokes erase the fill entirely on 7d+ hourly
// views), so the stack switches to areas, which have no per-mark spacer.
const DENSE_BUCKETS = 48

export function StatusChart() {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  const buckets = data?.data ?? []
  const dense = buckets.length > DENSE_BUCKETS
  const clipMax = clampedYMax(
    buckets.map((d) => STATUS_KEYS.reduce((sum, key) => sum + (d[key] ?? 0), 0)),
  )
  const SeriesChart = dense ? AreaChart : BarChart
  const state = dataState(isLoading, isError, buckets.length)

  return (
    <SignalPanel
      title="Status classes"
      description="HTTP response classes across the selected request volume."
      state={state}
      error={error?.message ?? "Failed to load status classes."}
      onRetry={() => void refetch()}
      bodyClassName="min-h-[240px]"
      actions={
        <>
          {clipMax != null && <span>y-axis clipped at {formatNumber(clipMax)}</span>}
          <GranularityBadge granularity={data?.granularity} />
        </>
      }
      legend={<ChartLegendRow config={statusChartConfig} label="Status chart legend" />}
    >
      {data && (
        <ChartContainer config={statusChartConfig} className="h-[240px] w-full">
          <SeriesChart data={buckets}>
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
    </SignalPanel>
  )
}
