import { useMemo } from "react"
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import type { TimeSeriesResponse } from "@/lib/api"
import { useRuntimeSettings } from "@/lib/queries"
import { fillHourlyGaps } from "./traffic-series"

/** The server's default ANALYTICS_HOURLY_RETENTION_DAYS, until the settings arrive. */
const DEFAULT_HOURLY_RETENTION_DAYS = 60
const DAY_MS = 86_400_000

/** The time-series rows with the hours the endpoint leaves out put back as empty buckets. */
export function useTrafficBuckets(data: TimeSeriesResponse | undefined): TimeSeriesDataPoint[] {
  const retentionDays =
    useRuntimeSettings().data?.analytics.hourlyRetentionDays ?? DEFAULT_HOURLY_RETENTION_DAYS
  return useMemo(
    () => (data ? fillHourlyGaps(data, Date.now() - retentionDays * DAY_MS) : []),
    [data, retentionDays],
  )
}
