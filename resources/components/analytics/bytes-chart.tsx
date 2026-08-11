import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes } from "@/lib/api"
import { clampedYMax } from "@/lib/chart-scale"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { TimeSeriesTooltip } from "./time-series-tooltip"

const chartConfig = {
  totalBytesSent: { label: "Bytes sent", color: "var(--chart-2)" },
} satisfies ChartConfig

export function BytesChart() {
  const { data, isLoading } = useTimeSeries()
  const clipMax = clampedYMax((data?.data ?? []).map((d) => d.totalBytesSent))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Bandwidth</CardTitle>
        {clipMax != null && (
          <CardAction className="text-xs text-muted-foreground">
            y-axis clipped at {formatBytes(clipMax)}
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
      </CardContent>
    </Card>
  )
}
