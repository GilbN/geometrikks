/**
 * The phone's live surface, and the only way into the feed sheet there.
 *
 * It answers two questions at a glance and nothing else: is traffic flowing,
 * and is anything attacking right now. Everything finer grained (error rate,
 * response mix, origins) lives one tap away in the sheet, where there is room
 * to read it.
 */
import { ChevronUp, ShieldAlert } from "lucide-react"
import { useLiveFeedState, useLiveVitals } from "@/lib/live-traffic/context"
import { formatNumber } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Sparkline } from "./LiveSummary"

export function LiveVitalsPill({ onOpenFeed }: { onOpenFeed: () => void }) {
  const vitals = useLiveVitals()
  const feedState = useLiveFeedState()
  const disconnected = feedState !== "connected"
  const underAttack = vitals.threatCount > 0

  return (
    <button
      type="button"
      onClick={onOpenFeed}
      aria-label={
        disconnected
          ? feedState === "paused"
            ? "Live feed paused by the server. Open the live request feed"
            : "Live feed reconnecting. Open the live request feed"
          : `${vitals.rpm} requests per minute, ${vitals.threatCount} threats. Open the live request feed`
      }
      className={cn(
        "pointer-events-auto flex min-h-9 items-center gap-2 rounded-full border pl-3 pr-2 pointer-coarse:min-h-11",
        // A neutral press, not the cyan accent: unpaired with its foreground
        // token the accent flashes brighter than anything else on the map.
        "bg-background/85 text-xs backdrop-blur transition-colors active:bg-foreground/10",
        // A threat is the one thing worth changing the pill's own colour for.
        underAttack ? "border-red-500/45" : disconnected ? "border-border" : "border-primary/35",
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          disconnected ? "bg-muted-foreground" : "bg-primary animate-pulse",
        )}
      />

      {disconnected ? (
        <span className="text-muted-foreground">
          {feedState === "paused" ? "Live feed paused" : "Reconnecting"}
        </span>
      ) : (
        <>
          <span className="flex items-baseline gap-1">
            <span className="text-sm font-semibold leading-none tabular-nums">
              {formatNumber(vitals.rpm)}
            </span>
            <span className="text-[10px] text-muted-foreground">/min</span>
          </span>

          {/* Ambient rhythm: the shape says "busy" or "quiet" faster than the
              number changing does. */}
          <Sparkline values={vitals.sparkline} className="block h-3.5 w-10 shrink-0" />

          {underAttack && (
            <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-1.5 py-0.5 text-red-400">
              <ShieldAlert className="h-3 w-3" aria-hidden />
              <span className="text-[10px] font-semibold tabular-nums">
                {formatNumber(vitals.threatCount)}
              </span>
            </span>
          )}
        </>
      )}

      <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  )
}
