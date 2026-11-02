/**
 * The DROP mark: red text in a red ring with a stop icon. A CrowdSec ban is
 * a filled red tint, so a banned DROP IP still reads as two facts. The popup
 * variant is the inline-styled pill the map popups draw, since they render
 * outside the app's stylesheet.
 */
import { OctagonX } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export function DropBadge({
  sblId,
  variant,
  className,
}: {
  sblId?: string
  variant: "short" | "long" | "popup"
  className?: string
}) {
  const title = sblId ? `On the DROP list as ${sblId}` : "On the DROP list"
  if (variant === "popup") {
    return (
      <span
        title={title}
        className={className}
        style={{
          fontSize: "9px",
          fontWeight: 600,
          textTransform: "uppercase",
          color: "var(--destructive)",
          border: "1px solid color-mix(in oklch, var(--destructive) 55%, transparent)",
          padding: "0 4px",
          borderRadius: "9999px",
          flexShrink: 0,
        }}
      >
        DROP
      </span>
    )
  }
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        "border-destructive/55 font-semibold tracking-[0.02em] text-destructive",
        className,
      )}
    >
      <OctagonX aria-hidden />
      DROP
      {variant === "long" && sblId && (
        <>
          <span aria-hidden>·</span>
          <span className="font-mono text-[11px] font-medium opacity-85">{sblId}</span>
        </>
      )}
    </Badge>
  )
}
