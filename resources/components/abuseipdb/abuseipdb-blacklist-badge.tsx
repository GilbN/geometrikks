/** The mark for an IP on AbuseIPDB's blacklist, in the DROP mark's red ring. */
import { ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export function AbuseIpdbBlacklistBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      title="On AbuseIPDB's blacklist"
      className={cn("border-destructive/55 font-semibold tracking-[0.02em] text-destructive", className)}
    >
      <ShieldAlert aria-hidden />
      AbuseIPDB blacklist
    </Badge>
  )
}
