/**
 * The DROP mark: red text in a red ring with a stop icon. A CrowdSec ban is
 * a filled red tint, so a banned DROP IP still reads as two facts.
 */
import { OctagonX } from "lucide-react"
import { BadgeHint } from "@/components/badge-hint"
import { Badge } from "@/components/ui/badge"
import { SblRecordLink } from "@/components/drop/sbl-record-link"
import { dropBadgeLabel } from "@/lib/drop-lists"
import { cn } from "@/lib/utils"

export function DropBadge({
  sblId,
  variant,
  list = "drop",
  showListName = false,
  linked = false,
  insideButton = false,
  className,
}: {
  sblId?: string
  variant: "short" | "long"
  list?: "drop" | "asn-drop"
  /** Reads ASN-DROP rather than DROP on an ASN-DROP listing. */
  showListName?: boolean
  /** The long variant links its SBL id to the Spamhaus record. Off inside menus and dialog titles. */
  linked?: boolean
  insideButton?: boolean
  className?: string
}) {
  const label = dropBadgeLabel(list, showListName)
  const title = list === "asn-drop" ? "On the ASN-DROP list" : sblId ? `On the DROP list as ${sblId}` : "On the DROP list"
  return (
    <BadgeHint hint={title} tappable={!insideButton} holdsLink={linked}>
      <Badge
        variant="outline"
        className={cn(
          "border-destructive/55 font-semibold tracking-[0.02em] text-destructive",
          linked && "overflow-visible",
          className,
        )}
      >
        <OctagonX aria-hidden />
        {label}
        {variant === "long" && sblId && (
          <>
            <span aria-hidden>·</span>
            {linked ? (
              <span onClick={(event) => event.stopPropagation()}>
                <SblRecordLink sblId={sblId} className="font-mono text-[11px] font-medium opacity-85 hover:text-current hover:opacity-100" />
              </span>
            ) : (
              <span className="font-mono text-[11px] font-medium opacity-85">{sblId}</span>
            )}
          </>
        )}
      </Badge>
    </BadgeHint>
  )
}
