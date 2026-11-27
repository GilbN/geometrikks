import { useMemo } from "react"
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import type { TimeSeriesResponse } from "@/lib/api"
import { hasActiveAnalyticsFilters, useAnalyticsFilters } from "@/lib/analytics-filters-context"
import { useRuntimeSettings } from "@/lib/queries"
import { fillHourlyGaps } from "./traffic-series"

/** The server's default hourly and raw retention, until the settings arrive. */
const DEFAULT_HOURLY_RETENTION_DAYS = 60
const DEFAULT_RAW_RETENTION_DAYS = 180
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/**
 * Days of hours a series can rely on. A filtered series, muted IPs included,
 * reads the raw rows and the others read the hourly rollup. The muted flag
 * is what the request sends, so it decides here too.
 */
export function keptHourDays(
  filtered: boolean,
  mutedFlag: boolean,
  settings: { hourlyRetentionDays?: number; rawRetentionDays?: number } | undefined,
): number {
  return filtered || mutedFlag
    ? (settings?.rawRetentionDays ?? DEFAULT_RAW_RETENTION_DAYS)
    : (settings?.hourlyRetentionDays ?? DEFAULT_HOURLY_RETENTION_DAYS)
}

/** Where the kept hours begin, on the hour. */
export function useKeptSinceMs(): number {
  const settings = useRuntimeSettings().data?.analytics
  const { filters, muted } = useAnalyticsFilters()
  const retentionDays = keptHourDays(hasActiveAnalyticsFilters(filters), muted.flag, settings)
  // The clamp to now moves on with the hour at the next render.
  return Math.floor(Date.now() / HOUR_MS) * HOUR_MS - retentionDays * DAY_MS
}

/** The time-series rows with the hours the endpoint leaves out put back as empty buckets. */
export function useTrafficBuckets(data: TimeSeriesResponse | undefined): TimeSeriesDataPoint[] {
  const keptSinceMs = useKeptSinceMs()
  return useMemo(() => (data ? fillHourlyGaps(data, keptSinceMs) : []), [data, keptSinceMs])
}
