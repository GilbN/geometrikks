import type { ApiKeyView } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { StatusLed } from "@/components/settings/status-led"
import { scopeLabel, type UsageTone } from "@/components/settings/api-keys-logic"

/** Live glows green and stale amber, like the other status dots. Idle is a plain grey dot. */
export function UsageDot({ tone }: { tone: UsageTone }) {
  if (tone === "live") return <StatusLed tone="emerald" />
  if (tone === "stale") return <StatusLed tone="amber" />
  return <span className="inline-flex size-2 shrink-0 rounded-full bg-muted-foreground/60" />
}

export function ApiKeyScopeBadge({ apiKey, className }: { apiKey: ApiKeyView; className?: string }) {
  if (apiKey.expired) {
    return (
      <Badge variant="outline" className={cn("border-destructive/40 text-destructive", className)}>
        Expired
      </Badge>
    )
  }
  if (apiKey.scope === "read_write") {
    return (
      <Badge
        variant="outline"
        className={cn("border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400", className)}
      >
        {scopeLabel(apiKey.scope)}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className={cn("text-muted-foreground", className)}>
      {scopeLabel(apiKey.scope)}
    </Badge>
  )
}
