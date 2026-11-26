import { useMemo } from "react"
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import type { TimeSeriesResponse } from "@/lib/api"
import { useRuntimeSettings } from "@/lib/queries"
import { fillHourlyGaps } from "./traffic-series"

/** The server's default hourly and raw retention, until the settings arrive. */
const DEFAULT_HOURLY_RETENTION_DAYS = 60
const DEFAULT_RAW_RETENTION_DAYS = 180
const DAY_MS = 86_400_000

/** The time-series rows with the hours the endpoint leaves out put back as empty buckets. */
export function useTrafficBuckets(data: TimeSeriesResponse | undefined): TimeSeriesDataPoint[] {
  const settings = useRuntimeSettings().data?.analytics
  // Unfiltered series read the hourly rollup and filtered ones the raw rows, so
  // only hours inside both retentions are sure to be there.
  const retentionDays = Math.min(
    settings?.hourlyRetentionDays ?? DEFAULT_HOURLY_RETENTION_DAYS,
    settings?.rawRetentionDays ?? DEFAULT_RAW_RETENTION_DAYS,
  )
  return useMemo(
    () => (data ? fillHourlyGaps(data, Date.now() - retentionDays * DAY_MS) : []),
    [data, retentionDays],
  )
}
