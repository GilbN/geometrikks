import { useEffect } from "react"
import { CircleAlert, CircleCheck } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import type { PendingItem } from "../lib/storage"
import type { PendingView } from "./Popup"

/** Ids whose toast already showed in this open; a remount must not repeat it. */
const toasted = new Set<string>()

function useBanToast(item: PendingItem) {
  useEffect(() => {
    const result = item.kind === "ban" ? item.result : null
    if (result === null || toasted.has(item.id)) return
    toasted.add(item.id)
    if (result.ok) toast.success(result.message, { id: item.id })
    else toast.error(result.message, { id: item.id })
  }, [item])
}

/** What the right-click showed before the connection check settled, kept
 *  on screen when that check fails so a ban that went out stays visible. */
function Summary({ item }: { item: PendingItem }) {
  const result = item.kind === "ban" ? item.result : null
  const failed = item.kind === "not-ip" || (result !== null && !result.ok)
  const Icon = failed ? CircleAlert : CircleCheck
  const title =
    item.kind === "not-ip" ? "Not an IP address" : result ? result.message : `Look up ${item.ip}`
  return (
    <div
      role={failed ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border p-3 text-[13px]",
        failed ? "border-destructive/45 bg-destructive/10" : "bg-card",
      )}
    >
      <Icon
        aria-hidden
        className={cn("mt-0.5 size-4 shrink-0", failed ? "text-destructive" : "text-emerald-500")}
      />
      <div className="min-w-0">
        <p className="font-semibold break-words">{title}</p>
        {item.kind === "not-ip" && (
          <p className="mt-0.5 font-mono text-[12.5px] break-all text-muted-foreground">
            {item.text}
          </p>
        )}
      </div>
    </div>
  )
}

/** A right-click result. A lookup shows the IP, a ban shows its toast over
 *  a lookup with the new decision, and other text shows "Not an IP
 *  address" with the text in the search field. Without a session it shows
 *  the summary only. */
export function PendingResult({ item, view }: { item: PendingItem; view: PendingView }) {
  useBanToast(item)
  if (view.session === null) return <Summary item={item} />
  return item.ip === null ? view.home(item.text) : view.lookup(item.ip)
}
