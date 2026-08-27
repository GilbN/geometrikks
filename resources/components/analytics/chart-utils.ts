/**
 * Series configs for the analytics charts, shared with their legends so
 * labels and colors cannot drift between the chart and its footer. Chart
 * slots are categorical and deliberately separate from the brand accent.
 */
import type { ChartConfig } from "@/components/ui/chart"

export const requestsChartConfig = {
  totalRequests: { label: "Requests", color: "var(--chart-1)" },
} satisfies ChartConfig

// Slot order matches the stack order: adjacent-pair CVD separation of the
// palette is only guaranteed for slots used in sequence.
export const statusChartConfig = {
  status2xx: { label: "2xx Success", color: "var(--chart-1)" },
  status3xx: { label: "3xx Redirection", color: "var(--chart-2)" },
  status4xx: { label: "4xx Client error", color: "var(--chart-3)" },
  status5xx: { label: "5xx Server error", color: "var(--chart-4)" },
} satisfies ChartConfig

export const bytesChartConfig = {
  totalBytesSent: { label: "Bytes sent", color: "var(--chart-2)" },
} satisfies ChartConfig

export const latencyChartConfig = {
  avgRequestTime: { label: "Average", color: "var(--chart-1)" },
  p50RequestTime: { label: "p50", color: "var(--chart-2)" },
  p95RequestTime: { label: "p95", color: "var(--chart-3)" },
  p99RequestTime: { label: "p99", color: "var(--chart-4)" },
} satisfies ChartConfig
