import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { formatDuration } from "@/lib/api"
import { clampedYMax } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { ChartLegendRow } from "./chart-legend-row"
import { latencyChartConfig } from "./chart-utils"
import { GranularityBadge } from "./granularity-badge"
import { TimeSeriesTooltip } from "./time-series-tooltip"

const SERIES = Object.keys(latencyChartConfig) as (keyof typeof latencyChartConfig)[]

export function LatencyChart() {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  const points = data?.data ?? []
  const clipMax = clampedYMax(points.flatMap((d) => SERIES.map((key) => d[key])))
  const state = dataState(isLoading, isError, points.length)

  return (
    <SignalPanel
      title="Request latency"
      description="Average and percentile response time in the selected range."
      state={state}
      error={error?.message ?? "Failed to load request latency."}
      onRetry={() => void refetch()}
      bodyClassName="min-h-[240px]"
      actions={
        <>
          {clipMax != null && <span>y-axis clipped at {formatDuration(clipMax * 1000)}</span>}
          <GranularityBadge granularity={data?.granularity} />
        </>
      }
      legend={<ChartLegendRow config={latencyChartConfig} label="Latency chart legend" />}
    >
      {data && (
        <ChartContainer config={latencyChartConfig} className="h-[240px] w-full">
          <LineChart data={points}>
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
              width={56}
              // request_time is seconds; formatDuration takes ms
              tickFormatter={(v: number) => formatDuration(v * 1000)}
              domain={clipMax != null ? [0, clipMax] : undefined}
              allowDataOverflow={clipMax != null}
            />
            <ChartTooltip
              content={
                <TimeSeriesTooltip
                  granularity={data.granularity}
                  formatter={(value, name) => (
                    <span className="flex w-full justify-between gap-2">
                      <span className="text-muted-foreground">
                        {latencyChartConfig[name as keyof typeof latencyChartConfig]?.label ?? name}
                      </span>
                      <span className="font-mono tabular-nums">{formatDuration(Number(value) * 1000)}</span>
                    </span>
                  )}
                />
              }
            />
            {SERIES.map((key) => (
              <Line
                key={key}
                dataKey={key}
                type="monotone"
                stroke={`var(--color-${key})`}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      )}
    </SignalPanel>
  )
}
