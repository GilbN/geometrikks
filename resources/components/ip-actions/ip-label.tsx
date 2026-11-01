import { DROP_UNDERLINE_CLASS, DropMarkSrText } from "@/components/drop/drop-mark"
import { useBannedIps, useDropNetwork } from "@/lib/queries"
import { decisionLabel } from "@/lib/crowdsec"
import { dropMarkTitle } from "@/lib/drop-lists"
import { cn } from "@/lib/utils"

/** The same tones as the table DecisionBadge. */
function decisionTone(type: string): string {
  if (type === "ban") return "bg-destructive/10 text-destructive dark:bg-destructive/20"
  if (type === "captcha") return "bg-amber-500/10 text-amber-500 dark:bg-amber-500/20"
  return "bg-secondary text-secondary-foreground"
}

/**
 * An IP in a table cell. An IP with an active CrowdSec decision takes the
 * decision badge's colours instead of carrying a separate badge, and an IP
 * in a DROP network gets the dashed DROP underline.
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
  const dropNetwork = useDropNetwork(ip)
  const decision = bannedIps?.get(ip) ?? null
  const dropMark = dropNetwork !== null && DROP_UNDERLINE_CLASS
  if (decision === null) {
    return (
      <span
        className={cn("font-mono", dropMark, className)}
        title={dropNetwork ? dropMarkTitle(dropNetwork.sblId) : undefined}
      >
        {ip}
        {dropNetwork && <DropMarkSrText />}
      </span>
    )
  }
  const decisionTitle = title?.(decision) ?? `Active CrowdSec ${decision} decision`
  return (
    <span
      className={cn("relative -ml-1.5 rounded-md px-1.5 py-0.5 font-mono", decisionTone(decision), dropMark, className)}
      title={dropNetwork ? dropMarkTitle(dropNetwork.sblId, decisionTitle) : decisionTitle}
    >
      {ip}
      <span className="sr-only"> ({decisionLabel(decision)})</span>
      {dropNetwork && <DropMarkSrText />}
    </span>
  )
}
