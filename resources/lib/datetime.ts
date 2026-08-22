/**
 * Timestamp formatting for the time-series charts.
 *
 * The API sends UTC instants; everything on screen is browser-local. Locale is
 * left undefined on purpose so the browser decides, and the Intl instances are
 * module-level because constructing one per tick is the expensive part of Intl.
 *
 * This is the single source of truth for chart timestamps: axis ticks and
 * tooltip headers both go through `formatTs`, so a point can never render one
 * way on the gridline and another way in the tooltip.
 */

/**
 * The browser's IANA timezone, sent as the `tz` query param so the API can
 * bucket daily chart data into local days instead of UTC days.
 */
export const BROWSER_TZ = new Intl.DateTimeFormat().resolvedOptions().timeZone

const HOURLY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

const DAILY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
})

/**
 * Format a bucket timestamp in the browser's timezone: day + hour:minute for
 * hourly buckets, day alone for daily ones. Unparseable input is passed through
 * rather than rendered as "Invalid Date".
 */
export function formatTs(value: string | number | Date, granularity?: string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  return (granularity === "hourly" ? HOURLY : DAILY).format(date)
}
