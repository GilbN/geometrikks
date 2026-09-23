import { useMemo } from "react"
import { Area, Bar, CartesianGrid, ComposedChart, XAxis, YAxis } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { formatNumber } from "@/lib/api"
import { useChartOptions } from "@/lib/chart-options"
import { scaleSeries } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { ChartLegendRow } from "./chart-legend-row"
import { ChartOptionsMenu, ScaleNotes } from "./chart-options-menu"
import { AREA_BARS_OPTIONS, barSpacer, formatLogCount, requestsChartConfig } from "./chart-utils"
import { GranularityBadge } from "./granularity-badge"
import { TimeSeriesTooltip } from "./time-series-tooltip"

const SERIES = ["totalRequests"] as const

export function RequestsChart() {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  const options = useChartOptions("requests", AREA_BARS_OPTIONS)
  const points = useMemo(() => data?.data ?? [], [data])
  const series = useMemo(
    () => scaleSeries(points, SERIES, options.scale, { integer: true }),
    [points, options.scale],
  )
  const state = dataState(isLoading, isError, points.length)

  return (
    <SignalPanel
      title="Requests"
      description="Request volume over the selected range."
      state={state}
      error={error?.message ?? "Failed to load request volume."}
      onRetry={() => void refetch()}
      bodyClassName="min-h-[240px]"
      actions={
        <>
          <ScaleNotes
            clip={series.clipMax != null ? formatNumber(series.clipMax) : null}
            zerosRaised={series.zerosRaised}
          />
          <GranularityBadge granularity={data?.granularity} />
          <ChartOptionsMenu title="Requests" spec={AREA_BARS_OPTIONS} options={options} />
        </>
      }
      legend={<ChartLegendRow config={requestsChartConfig} label="Requests chart legend" />}
    >
      {data && (
        <ChartContainer config={requestsChartConfig} className="h-[240px] w-full">
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
              width={48}
              tickFormatter={(v: number) => (options.scale === "log" ? formatLogCount(v) : formatNumber(v))}
              {...series.axis}
            />
            <ChartTooltip content={<TimeSeriesTooltip granularity={data.granularity} />} />
            {options.view.id === "bars" ? (
              <Bar
                dataKey="totalRequests"
                fill="var(--color-totalRequests)"
                radius={[2, 2, 0, 0]}
                {...barSpacer(points.length)}
              />
            ) : (
              <Area
                dataKey="totalRequests"
                type="monotone"
                fill="var(--color-totalRequests)"
                fillOpacity={0.2}
                stroke="var(--color-totalRequests)"
                strokeWidth={2}
              />
            )}
          </ComposedChart>
        </ChartContainer>
      )}
    </SignalPanel>
  )
}
