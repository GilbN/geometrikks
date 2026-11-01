import { DROP_STALE_NOTE, dropCreditText } from "@/lib/drop-lists"
import { cn } from "@/lib/utils"

/** The attribution line under every DROP figure, with an out-of-date note when no download has worked for a week. */
export function DropCredit({
  updatedAt,
  stale,
  className,
}: {
  updatedAt: string | null | undefined
  stale: boolean
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
    </p>
  )
}
