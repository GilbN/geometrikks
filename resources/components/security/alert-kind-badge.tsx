/**
 * The badge for an alert's origin: WAF in sky, bot detection in violet, any
 * other non-default kind plain. Renders nothing for log-scenario alerts,
 * which are the default and would all carry the same badge.
 */
import { Badge } from "@/components/ui/badge"
import { kindBadgeClass, kindLabel } from "@/lib/crowdsec-alerts"
import { cn } from "@/lib/utils"

export function AlertKindBadge({ kind, className }: { kind: string | null; className?: string }) {
  const label = kindLabel(kind)
  if (label === null) return null
  return (
    <Badge variant="secondary" className={cn("border-transparent", kindBadgeClass(kind ?? ""), className)}>
      {label}
    </Badge>
  )
}
