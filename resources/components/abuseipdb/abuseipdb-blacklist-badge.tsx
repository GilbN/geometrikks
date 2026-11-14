/** The mark for an IP on AbuseIPDB's blacklist, in the DROP mark's red ring. */
import { ShieldAlert } from "lucide-react"
import { BadgeHint } from "@/components/badge-hint"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const ABUSEIPDB_BLACKLIST_HINT = "On AbuseIPDB's blacklist of IPs with a 100% abuse confidence score"

export function AbuseIpdbBlacklistBadge({
  insideButton = false,
  hover,
  variant = "long",
  className,
}: {
  insideButton?: boolean
  hover?: "title" | "tooltip"
  variant?: "long" | "short"
  className?: string
}) {
  return (
    <BadgeHint hint={ABUSEIPDB_BLACKLIST_HINT} tappable={!insideButton} hover={hover}>
      <Badge
        variant="outline"
        className={cn("border-destructive/55 font-semibold tracking-[0.02em] text-destructive", className)}
      >
        <ShieldAlert aria-hidden />
        {variant === "short" ? "Blacklist" : "AbuseIPDB blacklist"}
      </Badge>
    </BadgeHint>
  )
}
