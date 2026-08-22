import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { formatNumber } from "@/lib/api"
import { clampedYMax } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { ChartLegendRow } from "./chart-legend-row"
import { requestsChartConfig } from "./chart-utils"
import { GranularityBadge } from "./granularity-badge"
import { TimeSeriesTooltip } from "./time-series-tooltip"

export function RequestsChart() {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  const points = data?.data ?? []
  const clipMax = clampedYMax(points.map((d) => d.totalRequests))
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
          {clipMax != null && <span>y-axis clipped at {formatNumber(clipMax)}</span>}
          <GranularityBadge granularity={data?.granularity} />
        </>
      }
      legend={<ChartLegendRow config={requestsChartConfig} label="Requests chart legend" />}
    >
      {data && (
        <ChartContainer config={requestsChartConfig} className="h-[240px] w-full">
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
              dataKey="totalRequests"
              type="monotone"
              fill="var(--color-totalRequests)"
              fillOpacity={0.2}
              stroke="var(--color-totalRequests)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </SignalPanel>
  )
}
