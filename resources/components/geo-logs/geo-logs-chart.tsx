/**
 * Time-series chart for the geo-logs page: bucketed geo-event totals and
 * unique IPs, honoring the shared filter set and the global time range.
 */
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { formatNumber } from "@/lib/api"
import { useGeoLogTimeSeries } from "@/lib/queries"
import { formatBucketTick } from "@/components/analytics/chart-utils"

const chartConfig = {
  totalEvents: { label: "Events", color: "var(--chart-1)" },
  uniqueIps: { label: "Unique IPs", color: "var(--chart-2)" },
} satisfies ChartConfig

export function GeoLogsChart() {
  const { data, isLoading } = useGeoLogTimeSeries()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Geo Events Over Time</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-[280px] w-full" />
        ) : (
          <ChartContainer config={chartConfig} className="h-[280px] w-full">
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
                width={48}
                tickFormatter={(v: number) => formatNumber(v)}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
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
      </CardContent>
    </Card>
  )
}
