/**
 * The badge for an alert's origin: WAF in sky, bot rejections in violet, bot
 * bans in a deeper violet, any other non-default kind plain. Renders nothing
 * for log-scenario alerts, which are the default and would all carry the
 * same badge.
 */
import { Badge } from "@/components/ui/badge"
import { alertBadge } from "@/lib/crowdsec-alerts"
import { cn } from "@/lib/utils"

export function AlertKindBadge({
  kind,
  scenario,
  className,
}: {
  kind: string | null
  scenario: string
  className?: string
}) {
  const badge = alertBadge(kind, scenario)
  if (badge === null) return null
  return (
    <Badge variant="secondary" className={cn("border-transparent", badge.className, className)}>
      {badge.label}
    </Badge>
  )
}
