import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes } from "@/lib/api"
import { useTimeSeries } from "@/lib/queries"
import { formatBucketTick } from "./chart-utils"

const chartConfig = {
  total_bytes_sent: { label: "Bytes sent", color: "var(--chart-2)" },
} satisfies ChartConfig

export function BytesChart() {
  const { data, isLoading } = useTimeSeries()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Bandwidth</CardTitle>
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
                tickFormatter={formatBucketTick(data.granularity)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={64}
                tickFormatter={(v: number) => formatBytes(v)}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => formatBytes(Number(value))}
                  />
                }
              />
              <Area
                dataKey="total_bytes_sent"
                type="monotone"
                fill="var(--color-total_bytes_sent)"
                fillOpacity={0.2}
                stroke="var(--color-total_bytes_sent)"
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
