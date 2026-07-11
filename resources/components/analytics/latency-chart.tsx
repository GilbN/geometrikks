import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDuration } from "@/lib/api"
import { useTimeSeries } from "@/lib/queries"
import { formatBucketTick } from "./chart-utils"

const chartConfig = {
  avg_request_time: { label: "avg", color: "var(--chart-1)" },
  p50_request_time: { label: "p50", color: "var(--chart-2)" },
  p95_request_time: { label: "p95", color: "var(--chart-3)" },
  p99_request_time: { label: "p99", color: "var(--chart-4)" },
} satisfies ChartConfig

const SERIES = Object.keys(chartConfig) as (keyof typeof chartConfig)[]

export function LatencyChart() {
  const { data, isLoading } = useTimeSeries()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Latency (avg / p50 / p95 / p99)</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-[240px] w-full" />
        ) : (
          <ChartContainer config={chartConfig} className="h-[240px] w-full">
            <LineChart data={data.data}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="timestamp"
                tickLine={false}
                axisLine={false}
                tickFormatter={formatBucketTick(data.granularity)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                // request_time is seconds; formatDuration takes ms
                tickFormatter={(v: number) => formatDuration(v * 1000)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => (
                      <span className="flex w-full justify-between gap-2">
                        <span className="text-muted-foreground">
                          {chartConfig[name as keyof typeof chartConfig]?.label ?? name}
                        </span>
                        <span className="font-mono tabular-nums">
                          {formatDuration(Number(value) * 1000)}
                        </span>
                      </span>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {SERIES.map((key) => (
                <Line
                  key={key}
                  dataKey={key}
                  type="monotone"
                  stroke={`var(--color-${key})`}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
