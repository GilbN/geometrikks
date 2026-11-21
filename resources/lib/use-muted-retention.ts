import { parseTimeRange } from "./api"
import { retentionNoteFor, type MutedScope } from "./muted-ips"
import { useRuntimeSettings } from "./queries"
import { useTimeRange } from "./time-range-context"

/** Whether muted IPs push the selected range past raw retention, and the days it reaches back. */
export function useMutedRetention(scope: MutedScope): {
  active: boolean
  days: number
  rangeMs: number
} {
  const { range, customRange } = useTimeRange()
  const { data } = useRuntimeSettings()
  const now = Date.now()
  const { startDate, endDate } = parseTimeRange(range, now, customRange)
  const days = data?.analytics.rawRetentionDays ?? 0
  const start = new Date(startDate)
  const active =
    data !== undefined &&
    retentionNoteFor({
      flag: scope.flag,
      rangeStart: start,
      now: new Date(now),
      rawRetentionDays: days,
    })
  return { active, days, rangeMs: Date.parse(endDate) - start.getTime() }
}
