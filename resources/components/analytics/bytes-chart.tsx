import { useMemo } from "react"
import { Area, Bar, CartesianGrid, ComposedChart, XAxis, YAxis } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { formatBytes } from "@/lib/api"
import { useChartOptions } from "@/lib/chart-options"
import { scaleSeries } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { ChartLegendRow } from "./chart-legend-row"
import { ChartOptionsMenu, ScaleNotes } from "./chart-options-menu"
import { AREA_BARS_OPTIONS, barSpacer, bytesChartConfig } from "./chart-utils"
import { GranularityBadge } from "./granularity-badge"
import { TimeSeriesTooltip } from "./time-series-tooltip"

const SERIES = ["totalBytesSent"] as const

export function BytesChart() {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  const options = useChartOptions("bytes", AREA_BARS_OPTIONS)
  const points = useMemo(() => data?.data ?? [], [data])
  const series = useMemo(
    () => scaleSeries(points, SERIES, options.scale, { base: 1024, integer: true }),
    [points, options.scale],
  )
  const state = dataState(isLoading, isError, points.length)

  return (
    <SignalPanel
      title="Bandwidth"
      description="Response bytes sent over the selected range."
      state={state}
      error={error?.message ?? "Failed to load bandwidth."}
      onRetry={() => void refetch()}
      bodyClassName="min-h-[240px]"
      actions={
        <>
          <ScaleNotes
            clip={series.clipMax != null ? formatBytes(series.clipMax) : null}
            zerosRaised={series.zerosRaised}
          />
          <GranularityBadge granularity={data?.granularity} />
          <ChartOptionsMenu title="Bandwidth" spec={AREA_BARS_OPTIONS} options={options} />
        </>
      }
      legend={<ChartLegendRow config={bytesChartConfig} label="Bandwidth chart legend" />}
    >
      {data && (
        <ChartContainer config={bytesChartConfig} className="h-[240px] w-full">
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
              width={64}
              tickFormatter={(v: number) => formatBytes(v)}
              {...series.axis}
            />
            <ChartTooltip
              content={
                <TimeSeriesTooltip
                  granularity={data.granularity}
                  formatter={(value) => formatBytes(Number(value))}
                />
              }
            />
            {options.view.id === "bars" ? (
              <Bar
                dataKey="totalBytesSent"
                fill="var(--color-totalBytesSent)"
                radius={[2, 2, 0, 0]}
                {...barSpacer(points.length)}
              />
            ) : (
              <Area
                dataKey="totalBytesSent"
                type="monotone"
                fill="var(--color-totalBytesSent)"
                fillOpacity={0.2}
                stroke="var(--color-totalBytesSent)"
                strokeWidth={2}
              />
            )}
          </ComposedChart>
        </ChartContainer>
      )}
    </SignalPanel>
  )
}
