import { DROP_ASN_STALE_NOTE, dropCreditText } from "@/lib/drop-lists"
import { cn } from "@/lib/utils"

/** The attribution line under every DROP figure, with an out-of-date note when the ASN list has not downloaded for a week. */
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
          . <span className="text-amber-600 dark:text-amber-400">{DROP_ASN_STALE_NOTE}</span>
        </>
      )}
    </p>
  )
}
