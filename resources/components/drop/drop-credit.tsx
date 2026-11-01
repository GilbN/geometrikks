import { Link } from "@tanstack/react-router"
import { DROP_STALE_NOTE, dropCreditText } from "@/lib/drop-lists"
import { cn } from "@/lib/utils"

/** The attribution line under every DROP figure, with an out-of-date note when no download has worked for a week. */
export function DropCredit({
  updatedAt,
  stale,
  securityLink = false,
  className,
}: {
  updatedAt: string | null | undefined
  stale: boolean
  /** Links to the Security page's DROP networks card; pass only when CrowdSec is enabled. */
  securityLink?: boolean
  className?: string
}) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      {dropCreditText(updatedAt)}
      {stale && (
        <>
          . <span className="text-amber-600 dark:text-amber-400">{DROP_STALE_NOTE}</span>
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
