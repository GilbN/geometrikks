import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { SignalPanel } from "@/components/data/signal-panel"
import { dataState } from "@/components/data/types"
import { ChartContainer, ChartTooltip } from "@/components/ui/chart"
import { formatBytes } from "@/lib/api"
import { clampedYMax } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { ChartLegendRow } from "./chart-legend-row"
import { bytesChartConfig } from "./chart-utils"
import { GranularityBadge } from "./granularity-badge"
import { TimeSeriesTooltip } from "./time-series-tooltip"

export function BytesChart() {
  const { data, error, isLoading, isError, refetch } = useTimeSeries()
  const points = data?.data ?? []
  const clipMax = clampedYMax(points.map((d) => d.totalBytesSent))
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
          {clipMax != null && <span>y-axis clipped at {formatBytes(clipMax)}</span>}
          <GranularityBadge granularity={data?.granularity} />
        </>
      }
      legend={<ChartLegendRow config={bytesChartConfig} label="Bandwidth chart legend" />}
    >
      {data && (
        <ChartContainer config={bytesChartConfig} className="h-[240px] w-full">
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
              width={64}
              tickFormatter={(v: number) => formatBytes(v)}
              domain={clipMax != null ? [0, clipMax] : undefined}
              allowDataOverflow={clipMax != null}
            />
            <ChartTooltip
              content={
                <TimeSeriesTooltip
                  granularity={data.granularity}
                  formatter={(value) => formatBytes(Number(value))}
                />
              }
            />
            <Area
              dataKey="totalBytesSent"
              type="monotone"
              fill="var(--color-totalBytesSent)"
              fillOpacity={0.2}
              stroke="var(--color-totalBytesSent)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </SignalPanel>
  )
}
