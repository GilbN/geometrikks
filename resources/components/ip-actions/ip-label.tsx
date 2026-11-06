import type { ReactNode } from "react"
import { DROP_OUTLINE_CLASS, DropMarkSrText } from "@/components/drop/drop-mark"
import { useBannedIps, useDropNetwork } from "@/lib/queries"
import { decisionLabel } from "@/lib/crowdsec"
import { dropMarkTitle } from "@/lib/drop-lists"
import { cn } from "@/lib/utils"

/** The box a decision fill or the DROP outline draws around the IP; the negative margin keeps the text in line with unmarked IPs. */
const IP_PILL_CLASS = "relative -ml-1.5 rounded-md px-1.5 py-0.5"

/** The same tones as the table DecisionBadge. */
function decisionTone(type: string): string {
  if (type === "ban") return "bg-destructive/10 text-destructive dark:bg-destructive/20"
  if (type === "captcha") return "bg-amber-500/10 text-amber-500 dark:bg-amber-500/20"
  return "bg-secondary text-secondary-foreground"
}

/**
 * An IP in a table cell. An IP with an active CrowdSec decision takes the
 * decision badge's colours instead of carrying a separate badge, and an IP
 * in a DROP network gets the dashed DROP outline around it.
 */
export function IpLabel({
  ip,
  title,
  prefix,
  className,
}: {
  ip: string
  /** Replaces the default tooltip for the decision type. */
  title?: (decisionType: string) => string
  /** Inside the marking, before the IP, as a map popup's rank. */
  prefix?: ReactNode
  className?: string
}) {
  const { data: bannedIps } = useBannedIps()
  const dropNetwork = useDropNetwork(ip)
  const decision = bannedIps?.get(ip) ?? null
  const dropMark = dropNetwork !== null && DROP_OUTLINE_CLASS
  if (decision === null) {
    return (
      <span
        className={cn("font-mono", dropNetwork && [IP_PILL_CLASS, dropMark], className)}
        title={dropNetwork ? dropMarkTitle(dropNetwork.sblId) : undefined}
      >
        {prefix}
        {ip}
        {dropNetwork && <DropMarkSrText sblId={dropNetwork.sblId} />}
      </span>
    )
  }
  const decisionTitle = title?.(decision) ?? `Active CrowdSec ${decision} decision`
  return (
    <span
      className={cn(IP_PILL_CLASS, "font-mono", decisionTone(decision), dropMark, className)}
      title={dropNetwork ? dropMarkTitle(dropNetwork.sblId, decisionTitle) : decisionTitle}
    >
      {prefix}
      {ip}
      <span className="sr-only"> ({decisionLabel(decision)})</span>
      {dropNetwork && <DropMarkSrText sblId={dropNetwork.sblId} />}
    </span>
  )
}
