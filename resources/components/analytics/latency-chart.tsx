import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { clampedYMax } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { formatDurationOrNa, TIMING_HINT } from "@/lib/timing"
import { ChartLegendRow } from "./chart-legend-row"
import { latencyChartConfig } from "./chart-utils"
import { GranularityBadge } from "./granularity-badge"
import { TimeSeriesTooltip } from "./time-series-tooltip"

const SERIES = Object.keys(latencyChartConfig) as (keyof typeof latencyChartConfig)[]

export function LatencyChart() {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  const points = data?.data ?? []
  const hasTimings = points.some((d) => d.timedRequests > 0)
  const noTimings = points.length > 0 && !hasTimings
  const clipMax = clampedYMax(points.flatMap((d) => SERIES.map((key) => d[key])))
  const state = dataState(isLoading, isError, noTimings ? 0 : points.length)

  return (
    <SignalPanel
      title="Request latency"
      description="Average and percentile response time in the selected range."
      state={state}
      error={error?.message ?? "Failed to load request latency."}
      empty={noTimings ? `No timing data in this range. ${TIMING_HINT}` : undefined}
      onRetry={() => void refetch()}
      bodyClassName="min-h-[240px]"
      actions={
        <>
          {clipMax != null && <span>y-axis clipped at {formatDurationOrNa(clipMax)}</span>}
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
              // request_time is seconds; formatDurationOrNa takes seconds
              tickFormatter={(v: number) => formatDurationOrNa(v)}
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
                      <span className="font-mono tabular-nums">
                        {formatDurationOrNa(value == null ? null : Number(value))}
                      </span>
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
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ChartContainer>
      )}
    </SignalPanel>
  )
}
