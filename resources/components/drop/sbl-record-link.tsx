import { sblRecordUrl } from "@/lib/drop-lists"
import { cn } from "@/lib/utils"

/** An SBL id that opens its record on check.spamhaus.org, in the dotted underline the map popups use. */
export function SblRecordLink({ sblId, className }: { sblId: string; className?: string }) {
  return (
    <a
      href={sblRecordUrl(sblId)}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${sblId} on check.spamhaus.org`}
      className={cn("tap-area underline decoration-dotted underline-offset-2 hover:text-foreground", className)}
    >
      {sblId}
    </a>
  )
}
