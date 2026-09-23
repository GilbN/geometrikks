/**
 * Time-series chart for the geo-logs page: bucketed geo-event totals and
 * unique IPs, honoring the shared filter set and the global time range.
 */
import { useMemo } from "react"
import { Area, Bar, CartesianGrid, ComposedChart, Rectangle, XAxis, YAxis, type RectangleProps } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { ChartLegendRow } from "@/components/analytics/chart-legend-row"
import { ChartOptionsMenu, ScaleNotes } from "@/components/analytics/chart-options-menu"
import { AREA_BARS_OPTIONS, barSpacer, formatLogCount } from "@/components/analytics/chart-utils"
import { GranularityBadge } from "@/components/analytics/granularity-badge"
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { formatNumber } from "@/lib/api"
import { useChartOptions } from "@/lib/chart-options"
import { scaleSeries } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useGeoLogTimeSeries } from "@/lib/queries"
import { TimeSeriesTooltip } from "@/components/analytics/time-series-tooltip"

const chartConfig = {
  totalEvents: { label: "Events", color: "var(--chart-1)" },
  uniqueIps: { label: "Unique IPs", color: "var(--chart-2)" },
} satisfies ChartConfig

const SERIES = ["totalEvents", "uniqueIps"] as const

/**
 * Unique IPs sit on a hidden second x-axis so Recharts gives them the full
 * band instead of a side-by-side slot; this draws them at half width,
 * centred on the Events bar. Unique IPs never exceed events.
 */
function InsetBar(props: unknown) {
  const rect = props as RectangleProps
  const { x = 0, width = 0 } = rect
  return <Rectangle {...rect} x={x + width / 4} width={width / 2} />
}

export function GeoLogsChart() {
  const { data, error, isLoading, isError, refetch } = useGeoLogTimeSeries()
  const options = useChartOptions("geo-events", AREA_BARS_OPTIONS)
  const points = useMemo(() => data?.data ?? [], [data])
  const series = useMemo(
    () => scaleSeries(points, SERIES, options.scale, { integer: true }),
    [points, options.scale],
  )
  const state = dataState(isLoading, isError, points.length)
  const bars = options.view.id === "bars"

  return (
    <SignalPanel
      title="Geo events over time"
      description="Event volume and unique clients across the selected range."
      state={state}
      error={error?.message ?? "Failed to load geo event history."}
      onRetry={() => void refetch()}
      bodyClassName="min-h-[280px]"
      actions={
        <>
          <ScaleNotes
            clip={series.clipMax != null ? formatNumber(series.clipMax) : null}
            zerosRaised={series.zerosRaised}
          />
          <GranularityBadge granularity={data?.granularity} />
          <ChartOptionsMenu title="Geo events over time" spec={AREA_BARS_OPTIONS} options={options} />
        </>
      }
      legend={<ChartLegendRow config={chartConfig} label="Geo event chart legend" />}
    >
      {data && (
        <ChartContainer config={chartConfig} className="h-[280px] w-full">
          <ComposedChart data={series.rows}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: string) => formatTs(v, data.granularity)}
            />
            {bars && <XAxis xAxisId="overlay" dataKey="timestamp" hide />}
            <YAxis
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(v: number) => (options.scale === "log" ? formatLogCount(v) : formatNumber(v))}
              {...series.axis}
            />
            <ChartTooltip content={<TimeSeriesTooltip granularity={data.granularity} />} />
            {bars
              ? [
                  <Bar
                    key="totalEvents"
                    dataKey="totalEvents"
                    fill="var(--color-totalEvents)"
                    radius={[2, 2, 0, 0]}
                    {...barSpacer(points.length)}
                  />,
                  <Bar
                    key="uniqueIps"
                    dataKey="uniqueIps"
                    xAxisId="overlay"
                    fill="var(--color-uniqueIps)"
                    radius={[2, 2, 0, 0]}
                    shape={InsetBar}
                    {...barSpacer(points.length)}
                  />,
                ]
              : SERIES.map((key) => (
                  <Area
                    key={key}
                    dataKey={key}
                    type="monotone"
                    fill={`var(--color-${key})`}
                    fillOpacity={0.2}
                    stroke={`var(--color-${key})`}
                    strokeWidth={2}
                  />
                ))}
          </ComposedChart>
        </ChartContainer>
      )}
    </SignalPanel>
  )
}
