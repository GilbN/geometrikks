import { BadgeHint } from "@/components/badge-hint"

/** Read-only label for the bucket size the API chose for a time series.
 * Not a control: granularity follows the selected range server-side. */
export function GranularityBadge({ granularity }: { granularity: string | undefined }) {
  if (!granularity) return null
  const label = granularity === "hourly" ? "Hourly" : granularity === "daily" ? "Daily" : granularity
  return (
    <BadgeHint hint="Bucket size chosen for the selected range">
      <span className="rounded-md border border-border/60 px-2 py-0.5 text-xs font-medium text-muted-foreground">{label}</span>
    </BadgeHint>
  )
}
