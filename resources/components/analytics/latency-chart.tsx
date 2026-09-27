import { useMemo } from "react"
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { useChartOptions } from "@/lib/chart-options"
import { scaleSeries } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { formatDurationOrNa, TIMING_HINT } from "@/lib/timing"
import { ChartLegendRow } from "./chart-legend-row"
import { ChartOptionsMenu, ScaleNotes } from "./chart-options-menu"
import { LATENCY_OPTIONS, latencyBandChartConfig, latencyChartConfig } from "./chart-utils"
import { GranularityBadge } from "./granularity-badge"
import { bandRows, LATENCY_KEYS, latencyTooltipRows } from "./latency-series"
import { TimeSeriesTooltip } from "./time-series-tooltip"

export function LatencyChart() {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  const options = useChartOptions("latency", LATENCY_OPTIONS)
  const points = useMemo(() => data?.data ?? [], [data])
  const hasTimings = points.some((d) => d.timedRequests > 0)
  const noTimings = points.length > 0 && !hasTimings
  const series = useMemo(() => {
    const scaled = scaleSeries(points, LATENCY_KEYS, options.scale)
    return { ...scaled, rows: bandRows(scaled.rows) }
  }, [points, options.scale])
  const band = options.view.id === "band"
  const config = band ? latencyBandChartConfig : latencyChartConfig
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
          <ScaleNotes
            clip={series.clipMax != null ? formatDurationOrNa(series.clipMax) : null}
            zerosRaised={series.zerosRaised}
          />
          <GranularityBadge granularity={data?.granularity} />
          <ChartOptionsMenu title="Request latency" spec={LATENCY_OPTIONS} options={options} />
        </>
      }
      legend={<ChartLegendRow config={config} label="Latency chart legend" />}
    >
      {data && (
        <ChartContainer config={config} className="h-[240px] w-full">
          <ComposedChart data={series.rows}>
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
              {...series.axis}
            />
            <ChartTooltip
              // Keep all-null buckets so the band tooltip can show four "n/a" rows.
              filterNull={!band}
              content={
                <TimeSeriesTooltip
                  granularity={data.granularity}
                  rows={band ? latencyTooltipRows : undefined}
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
            {band
              ? [
                  <Area
                    key="band"
                    dataKey="band"
                    type="monotone"
                    fill="var(--color-band)"
                    fillOpacity={0.25}
                    stroke="none"
                    connectNulls={false}
                  />,
                  <Line
                    key="p99"
                    dataKey="p99RequestTime"
                    type="monotone"
                    stroke="var(--color-p99RequestTime)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    dot={false}
                    connectNulls={false}
                  />,
                  <Line
                    key="avg"
                    dataKey="avgRequestTime"
                    type="monotone"
                    stroke="var(--color-avgRequestTime)"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                  />,
                ]
              : LATENCY_KEYS.map((key) => (
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
          </ComposedChart>
        </ChartContainer>
      )}
    </SignalPanel>
  )
}
