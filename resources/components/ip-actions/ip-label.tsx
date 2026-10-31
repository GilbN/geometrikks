import { useBannedIps } from "@/lib/queries"
import { decisionLabel } from "@/lib/crowdsec"
import { cn } from "@/lib/utils"

/** The same tones as the table DecisionBadge. */
function decisionTone(type: string): string {
  if (type === "ban") return "bg-destructive/10 text-destructive dark:bg-destructive/20"
  if (type === "captcha") return "bg-amber-500/10 text-amber-500 dark:bg-amber-500/20"
  return "bg-secondary text-secondary-foreground"
}

/**
 * An IP in a table cell. An IP with an active CrowdSec decision takes the
 * decision badge's colours instead of carrying a separate badge.
 */
export function IpLabel({
  ip,
  title,
  className,
}: {
  ip: string
  /** Replaces the default tooltip for the decision type. */
  title?: (decisionType: string) => string
  className?: string
}) {
  const { data: bannedIps } = useBannedIps()
  const decision = bannedIps?.get(ip) ?? null
  if (decision === null) return <span className={cn("font-mono", className)}>{ip}</span>
  return (
    <span
      className={cn("relative -ml-1.5 rounded-md px-1.5 py-0.5 font-mono", decisionTone(decision), className)}
      title={title?.(decision) ?? `Active CrowdSec ${decision} decision`}
    >
      {ip}
      <span className="sr-only"> ({decisionLabel(decision)})</span>
    </span>
  )
}
