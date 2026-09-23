/**
 * Series configs for the analytics charts, shared with their legends so
 * labels and colors cannot drift between the chart and its footer. Chart
 * slots are categorical and deliberately separate from the brand accent.
 */
import type { ChartConfig } from "@/components/ui/chart"
import type { ChartOptionsSpec } from "@/lib/chart-options"

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

/**
 * Above this many buckets the card-colored bar spacers are wider than the
 * bars (they erase the fill on 7d+ hourly views), so bar views drop them and
 * the status stack switches to areas.
 */
export const DENSE_BUCKETS = 48

export function barSpacer(buckets: number): { stroke?: string; strokeWidth?: number } {
  return buckets > DENSE_BUCKETS ? {} : { stroke: "var(--card)", strokeWidth: 1 }
}

const compactCount = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })

/**
 * Log count ticks: log ceilings round up to the next power of ten, so full
 * labels such as "100,000" overflow the 48px axis on narrow cards.
 */
export function formatLogCount(value: number): string {
  return compactCount.format(value)
}

/**
 * A 0..1 fraction as a percentage: 0.123 -> "12.3%", 0.0042 -> "0.42%".
 * Below 1% it keeps two significant digits, so ticks on a very low
 * error-rate axis stay distinct ("0.0025%", "0.005%").
 */
export function formatRate(value: number): string {
  const pct = value * 100
  if (pct !== 0 && Math.abs(pct) < 1) return `${Number(pct.toPrecision(2))}%`
  return `${pct.toFixed(1).replace(/\.0$/, "")}%`
}

export const AREA_BARS_OPTIONS = {
  views: [
    { id: "area", label: "Area", scales: ["clip", "full", "log"] },
    { id: "bars", label: "Bars", scales: ["clip", "full", "log"] },
  ],
} satisfies ChartOptionsSpec

export const STATUS_OPTIONS = {
  views: [
    { id: "stacked", label: "Stacked counts", scales: ["clip", "full", "log"], scaleHints: { log: "Shows as lines" } },
    { id: "share", label: "Share of responses", chip: "Share", scales: ["full"], fixedScaleNote: "Fixed 0 to 100% axis" },
    { id: "error-rate", label: "Error rate", scales: ["clip", "full"] },
  ],
} satisfies ChartOptionsSpec

export const LATENCY_OPTIONS = {
  views: [
    { id: "lines", label: "Lines", scales: ["clip", "full", "log"] },
    { id: "band", label: "Percentile band", chip: "Band", scales: ["clip", "full", "log"] },
  ],
} satisfies ChartOptionsSpec

// Uses the 5xx slot: the rate is the share of client and server errors.
export const statusErrorRateChartConfig = {
  errorRate: { label: "Error rate (4xx + 5xx)", color: "var(--chart-4)" },
} satisfies ChartConfig

// Keys match the band view's dataKeys; labels and --color-* vars resolve by key.
export const latencyBandChartConfig = {
  band: { label: "p50 to p95", color: "var(--chart-3)" },
  p99RequestTime: latencyChartConfig.p99RequestTime,
  avgRequestTime: latencyChartConfig.avgRequestTime,
} satisfies ChartConfig
