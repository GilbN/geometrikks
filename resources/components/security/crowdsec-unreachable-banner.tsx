/**
 * Destructive strip shown while the CrowdSec LAPI is unreachable. The
 * tables below keep rendering their last-known data; this strip is the
 * page's single "why is everything stale" explanation.
 */
import { AlertTriangle } from "lucide-react"
import { useCrowdsecStatus } from "@/lib/queries"

export function CrowdsecUnreachableBanner() {
  const { data: status } = useCrowdsecStatus()
  if (!status?.enabled || status.lapi_reachable) return null
  return (
    <div role="alert" className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        CrowdSec LAPI is unreachable. Showing last known data; bans and
        unbans will fail until the connection recovers.
      </span>
    </div>
  )
}
