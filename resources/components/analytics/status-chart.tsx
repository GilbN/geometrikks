import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { formatNumber } from "@/lib/api"
import { formatTs } from "@/lib/datetime"
import { useTimeSeries } from "@/lib/queries"
import { TimeSeriesTooltip } from "./time-series-tooltip"

// Slot order matches the stack order: adjacent-pair CVD separation of the
// palette is only guaranteed for slots used in sequence.
const chartConfig = {
  status2xx: { label: "2xx", color: "var(--chart-1)" },
  status3xx: { label: "3xx", color: "var(--chart-2)" },
  status4xx: { label: "4xx", color: "var(--chart-3)" },
  status5xx: { label: "5xx", color: "var(--chart-4)" },
} satisfies ChartConfig

export function StatusChart() {
  const { data, isLoading } = useTimeSeries()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Status classes</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-[240px] w-full" />
        ) : (
          <ChartContainer config={chartConfig} className="h-[240px] w-full">
            <BarChart data={data.data}>
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
              />
              <ChartTooltip content={<TimeSeriesTooltip granularity={data.granularity} />} />
              <ChartLegend content={<ChartLegendContent />} />
              {/* stroke = card surface: the 2px spacer between stacked segments */}
              <Bar dataKey="status2xx" stackId="s" fill="var(--color-status2xx)" stroke="var(--card)" strokeWidth={1} />
              <Bar dataKey="status3xx" stackId="s" fill="var(--color-status3xx)" stroke="var(--card)" strokeWidth={1} />
              <Bar dataKey="status4xx" stackId="s" fill="var(--color-status4xx)" stroke="var(--card)" strokeWidth={1} />
              <Bar dataKey="status5xx" stackId="s" fill="var(--color-status5xx)" stroke="var(--card)" strokeWidth={1} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
