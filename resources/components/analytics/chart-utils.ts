/**
 * Shared axis/tick helpers for the analytics charts.
 */

/** Format a bucket timestamp for the X axis: day+hour for hourly, day for daily. */
export function formatBucketTick(granularity: string) {
  return (value: string) =>
    new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      ...(granularity === "hourly" && { hour: "2-digit" }),
    })
}
