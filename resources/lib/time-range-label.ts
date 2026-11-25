/** How the top bar names the selected range and the span it covers. */
import {
  TIME_RANGE_PRESETS,
  parseTimeRange,
  type CustomTimeRange,
  type TimeRangeValue,
} from "@/lib/api"
import type { TimeFormat } from "@/lib/table-view"

const UNITS: Record<string, [string, string]> = {
  m: ["minute", "minutes"],
  h: ["hour", "hours"],
  d: ["day", "days"],
}

/** "Last 7 days", "Last hour", "Today": the preset's name in words. */
export function timeRangeName(range: TimeRangeValue): string {
  const relative = /^(\d+)([mhd])$/.exec(range)
  if (relative) {
    const count = Number(relative[1])
    const [one, many] = UNITS[relative[2]]
    return count === 1 ? `Last ${one}` : `Last ${count} ${many}`
  }
  return TIME_RANGE_PRESETS.find((preset) => preset.value === range)?.label ?? "Range"
}

/**
 * The span the range covers right now: "Nov 7 – Nov 14", clock times for a
 * span within today, and the day first for a span on an earlier day.
 */
export function timeRangeSpan(
  range: TimeRangeValue,
  customRange: CustomTimeRange | null,
  now: number,
  timeFormat: TimeFormat,
): string {
  const { startDate, endDate } = parseTimeRange(range, now, customRange)
  const start = new Date(startDate)
  const end = new Date(endDate)
  const sameDay = start.toDateString() === end.toDateString()
  const sameYear = start.getFullYear() === end.getFullYear()
  const day = (date: Date) =>
    date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    })
  const clock = (date: Date) =>
    timeFormat === "browser"
      ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  if (!sameDay) return `${day(start)} – ${day(end)}`
  if (range === "yesterday") return day(start)
  // A span on an earlier day names that day before its times.
  const today = new Date(now).toDateString() === start.toDateString()
  return `${today ? "" : `${day(start)}, `}${clock(start)} – ${clock(end)}`
}
