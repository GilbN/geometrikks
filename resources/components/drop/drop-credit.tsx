import { Link } from "@tanstack/react-router"
import { DROP_ASN_STALE_NOTE, dropCreditText } from "@/lib/drop-lists"
import { cn } from "@/lib/utils"

/** The attribution line under every DROP figure, with an out-of-date note when the list behind the figures has not downloaded for a week. */
export function DropCredit({
  updatedAt,
  stale,
  staleNote = DROP_ASN_STALE_NOTE,
  securityLink = false,
  className,
}: {
  updatedAt: string | null | undefined
  stale: boolean
  /** Names the list that is out of date; ASN-DROP unless the figures come from the network lists. */
  staleNote?: string
  /** Links to the Security page's DROP networks card; pass only when CrowdSec is enabled. */
  securityLink?: boolean
  className?: string
}) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      {dropCreditText(updatedAt)}
      {stale && (
        <>
          . <span className="text-amber-600 dark:text-amber-400">{staleNote}</span>
        </>
      )}
      {securityLink && (
        <>
          <span aria-hidden> · </span>
          <Link
            to="/security"
            hash="drop-networks"
            className="tap-area underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-foreground"
          >
            Review DROP networks on Security
          </Link>
        </>
      )}
    </p>
  )
}
