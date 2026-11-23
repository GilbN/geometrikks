import type { ReactNode } from "react"
import { DROP_OUTLINE_CLASS, DropMarkSrText } from "@/components/drop/drop-mark"
import { SrOnlySuffix } from "@/components/sr-only-suffix"
import { BLACKLIST_MARK_SR_TEXT, blacklistMarkTitle } from "@/lib/abuseipdb"
import { useAbuseIpdbBlacklisted, useBannedIps, useDropNetwork } from "@/lib/queries"
import { decisionLabel } from "@/lib/crowdsec"
import { dropMarkTitle } from "@/lib/drop-lists"
import { cn } from "@/lib/utils"

/** The box a decision fill or the dashed outline draws around the IP; the negative margin keeps the text in line with unmarked IPs. */
const IP_PILL_CLASS = "relative -ml-1.5 rounded-md px-1.5 py-0.5"

/** Keeps the head and tail of a long IPv6 address, about the width of an IPv4 one. */
export function shortIp(ip: string): string {
  return ip.length > 21 ? `${ip.slice(0, 12)}…${ip.slice(-7)}` : ip
}

/** The address as shown, with the whole one for screen readers when it is shortened. */
function IpText({ ip, short }: { ip: string; short: boolean }) {
  const text = short ? shortIp(ip) : ip
  if (text === ip) return ip
  return (
    <>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{ip}</span>
    </>
  )
}

/** The same tones as the table DecisionBadge. */
function decisionTone(type: string): string {
  if (type === "ban") return "bg-destructive/10 text-destructive dark:bg-destructive/20"
  if (type === "captcha") return "bg-amber-500/10 text-amber-500 dark:bg-amber-500/20"
  return "bg-secondary text-secondary-foreground"
}

/**
 * An IP in a table cell. An IP with an active CrowdSec decision takes the
 * decision badge's colours instead of carrying a separate badge, and an IP
 * in a DROP network or on AbuseIPDB's blacklist gets the dashed DROP outline
 * around it. The tooltip and screen-reader text name every mark.
 */
export function IpLabel({
  ip,
  title,
  prefix,
  short = false,
  className,
}: {
  ip: string
  /** Shortens a long IPv6 address in the middle; the tooltip has all of it. */
  short?: boolean
  /** Replaces the default tooltip for the decision type. */
  title?: (decisionType: string) => string
  /** Inside the marking, before the IP, as a map popup's rank. */
  prefix?: ReactNode
  className?: string
}) {
  const { data: bannedIps } = useBannedIps()
  const dropNetwork = useDropNetwork(ip)
  const blacklisted = useAbuseIpdbBlacklisted(ip)
  const decision = bannedIps?.get(ip) ?? null
  const outlined = dropNetwork !== null || blacklisted
  const decisionTitle =
    decision === null ? undefined : (title?.(decision) ?? `Active CrowdSec ${decision} decision`)
  const dropTitle = dropNetwork ? dropMarkTitle(dropNetwork.sblId, decisionTitle) : decisionTitle
  const marks = blacklisted ? blacklistMarkTitle(dropTitle) : dropTitle
  const markTitle = short && shortIp(ip) !== ip ? [ip, marks].filter(Boolean).join("\n") : marks
  const listSuffixes = (
    <>
      {dropNetwork && <DropMarkSrText sblId={dropNetwork.sblId} />}
      {blacklisted && <SrOnlySuffix text={BLACKLIST_MARK_SR_TEXT} />}
    </>
  )
  if (decision === null) {
    return (
      <span
        className={cn("font-mono", outlined && [IP_PILL_CLASS, DROP_OUTLINE_CLASS], className)}
        title={markTitle}
      >
        {prefix}
        <IpText ip={ip} short={short} />
        {listSuffixes}
      </span>
    )
  }
  return (
    <span
      className={cn(
        IP_PILL_CLASS,
        "font-mono",
        decisionTone(decision),
        outlined && DROP_OUTLINE_CLASS,
        className,
      )}
      title={markTitle}
    >
      {prefix}
      <IpText ip={ip} short={short} />
      <SrOnlySuffix text={` (${decisionLabel(decision)})`} />
      {listSuffixes}
    </span>
  )
}
