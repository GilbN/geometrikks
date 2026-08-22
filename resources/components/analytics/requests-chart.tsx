import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { formatNumber } from "@/lib/api"
import { clampedYMax } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { TimeSeriesTooltip } from "./time-series-tooltip"

const chartConfig = {
  totalRequests: { label: "Requests", color: "var(--chart-1)" },
} satisfies ChartConfig

export function RequestsChart() {
  const { data, isLoading } = useTimeSeries()
  const clipMax = clampedYMax((data?.data ?? []).map((d) => d.totalRequests))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Requests</CardTitle>
        {clipMax != null && (
          <CardAction className="text-xs text-muted-foreground">
            y-axis clipped at {formatNumber(clipMax)}
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-[240px] w-full" />
        ) : (
          <ChartContainer config={chartConfig} className="h-[240px] w-full">
            <AreaChart data={data.data}>
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
      </CardContent>
    </Card>
  )
}
