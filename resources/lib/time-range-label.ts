/** How the top bar names the selected range and the span it covers. */
import {
  TIME_RANGE_PRESETS,
  parseTimeRange,
  type CustomTimeRange,
  type TimeRangeValue,
} from "@/lib/api"
import type { TimeFormat } from "@/lib/table-view"

const DAY_MS = 24 * 60 * 60 * 1000

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
 * The span the range covers right now. A day or more shows dates, such as
 * "Nov 7 – Nov 14". Less than a day shows clock times, with the day in front
 * when it isn't today. Dates outside this year carry the year.
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
  const thisYear = new Date(now).getFullYear()
  const showYear = start.getFullYear() !== thisYear || end.getFullYear() !== thisYear
  const day = (date: Date) =>
    date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(showYear ? { year: "numeric" } : {}),
    })
  const clock = (date: Date) =>
    timeFormat === "browser"
      ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  if (range === "yesterday") return day(start)
  if (end.getTime() - start.getTime() >= DAY_MS) return `${day(start)} – ${day(end)}`
  const today = new Date(now).toDateString()
  const at = (date: Date) =>
    date.toDateString() === today ? clock(date) : `${day(date)}, ${clock(date)}`
  const sameDay = start.toDateString() === end.toDateString()
  return sameDay && start.toDateString() !== today
    ? `${day(start)}, ${clock(start)} – ${clock(end)}`
    : `${at(start)} – ${at(end)}`
}
