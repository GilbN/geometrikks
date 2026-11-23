import { formatClock24, formatDay, type TimeFormat } from "@/lib/table-view"

/**
 * A timestamp short enough for the second line of a narrow table row. Today
 * shows the time alone, this year the day and time, and earlier years the full
 * date. Today's time carries seconds unless `seconds` is false. The detail
 * sheet keeps the full timestamp. The 24-hour format reads "16:41:40" today
 * and "Nov 14 16:41" on other days.
 */
export function formatRowTime(
  value: string | number | Date,
  {
    now = new Date(),
    seconds = true,
    format = "browser",
  }: { now?: Date; seconds?: boolean; format?: TimeFormat } = {},
): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  const today = date.toDateString() === now.toDateString()
  if (format === "short24") {
    return today
      ? formatClock24(date, seconds)
      : `${formatDay(date, now)} ${formatClock24(date, false)}`
  }
  if (today) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: seconds ? "2-digit" : undefined,
    })
  }
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric"
  return date.toLocaleString(undefined, options)
}
