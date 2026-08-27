/**
 * Destructive strip shown while the CrowdSec LAPI is unreachable. The
 * tables below keep rendering their last-known data; this strip is the
 * page's single "why is everything stale" explanation.
 */
import { useCrowdsecStatus } from "@/lib/queries"
import { ErrorBanner } from "@/components/error-banner"

export function CrowdsecUnreachableBanner() {
  const { data: status } = useCrowdsecStatus()
  if (!status?.enabled || status.lapiReachable) return null
  return (
    <ErrorBanner
      title="CrowdSec LAPI is unreachable."
      detail="Showing last known data; bans and unbans will fail until the connection recovers."
    />
  )
}
