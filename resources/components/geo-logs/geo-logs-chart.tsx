/**
 * Time-series chart for the geo-logs page: bucketed geo-event totals and
 * unique IPs, honoring the shared filter set and the global time range.
 */
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { ChartLegendRow } from "@/components/analytics/chart-legend-row"
import { GranularityBadge } from "@/components/analytics/granularity-badge"
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
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
  const { data, error, isLoading, isError, refetch } = useGeoLogTimeSeries()
  const points = data?.data ?? []
  const clipMax = clampedYMax(points.flatMap((d) => [d.totalEvents, d.uniqueIps]))
  const state = dataState(isLoading, isError, points.length)

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
          {clipMax != null && <span>y-axis clipped at {formatNumber(clipMax)}</span>}
          <GranularityBadge granularity={data?.granularity} />
        </>
      }
      legend={<ChartLegendRow config={chartConfig} label="Geo event chart legend" />}
    >
      {data && (
        <ChartContainer config={chartConfig} className="h-[280px] w-full">
          <AreaChart data={points}>
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
    </SignalPanel>
  )
}
