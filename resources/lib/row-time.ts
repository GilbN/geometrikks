/**
 * A timestamp short enough for the second line of a narrow table row. Today
 * shows the time alone, this year the day and time, and earlier years the full
 * date. The detail sheet keeps the full timestamp.
 */
export function formatRowTime(value: string | number | Date, now: Date = new Date()): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })
  }
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric"
  return date.toLocaleString(undefined, options)
}
