/**
 * The badge for an active CrowdSec decision. Bans are red, captcha amber,
 * anything a bouncer defines itself grey with its own name. The table
 * variant is the shadcn Badge; the popup variant is the inline-styled pill
 * the map popups draw, since they render outside the app's stylesheet.
 */
import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { decisionLabel, decisionPopupColor } from "@/lib/crowdsec"
import { cn } from "@/lib/utils"

export function DecisionBadge({
  type,
  variant = "table",
  className,
  title,
  children,
}: {
  type: string
  variant?: "table" | "popup"
  className?: string
  /** Replaces the default "Active CrowdSec … decision" title. */
  title?: string
  /** Replaces the label; the inspector header appends scenario and expiry. */
  children?: ReactNode
}) {
  const badgeTitle = title ?? `Active CrowdSec ${type} decision`
  if (variant === "popup") {
    const color = decisionPopupColor(type)
    return (
      <span
        title={badgeTitle}
        style={{
          fontSize: "9px",
          fontWeight: 600,
          textTransform: "uppercase",
          color,
          background: `color-mix(in oklab, ${color} 15%, transparent)`,
          padding: "1px 5px",
          borderRadius: "9999px",
          flexShrink: 0,
        }}
      >
        {children ?? decisionLabel(type)}
      </span>
    )
  }
  return (
    <Badge
      variant={type === "ban" ? "destructive" : "secondary"}
      title={badgeTitle}
      className={cn(
        type === "captcha" && "bg-amber-500/10 text-amber-500 dark:bg-amber-500/20",
        className,
      )}
    >
      {children ?? decisionLabel(type)}
    </Badge>
  )
}
