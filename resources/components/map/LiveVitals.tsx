/**
 * Ambient live readout. Desktop renders a cluster over the map's top-left;
 * mobile renders the same numbers as a pill that opens the feed sheet.
 */
import { ChevronUp } from "lucide-react"
import { useLiveVitals } from "@/lib/live-traffic/context"
import { useLiveFeedStatus } from "@/lib/live-feed-context"
import { formatNumber } from "@/lib/api"
import { cn } from "@/lib/utils"

const SPARKLINE_WIDTH = 132
const SPARKLINE_HEIGHT = 24

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const peak = Math.max(1, ...values)
  const step = SPARKLINE_WIDTH / (values.length - 1)
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(SPARKLINE_HEIGHT - (value / peak) * SPARKLINE_HEIGHT).toFixed(1)}`)
    .join(" ")

  return (
    <svg width={SPARKLINE_WIDTH} height={SPARKLINE_HEIGHT} className="block" aria-hidden>
      <polyline points={points} fill="none" stroke="#22d3ee" strokeWidth={1.4} opacity={0.9} />
    </svg>
  )
}

export function LiveVitals({
  variant,
  onOpenFeed,
}: {
  variant: "desktop" | "pill"
  onOpenFeed?: () => void
}) {
  const vitals = useLiveVitals()
  const status = useLiveFeedStatus()
  const disconnected = status !== "connected"
  const errorPercent = (vitals.errorRate * 100).toFixed(1)

  if (variant === "pill") {
    return (
      <button
        type="button"
        onClick={onOpenFeed}
        aria-label="Open the live request feed"
        className={cn(
          "pointer-events-auto flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5",
          "text-xs backdrop-blur transition-colors active:bg-accent",
          disconnected ? "border-border text-muted-foreground" : "border-geo-cyan/35",
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            disconnected ? "bg-muted-foreground" : "bg-geo-cyan animate-pulse",
          )}
        />
        {disconnected ? (
          <span>Reconnecting</span>
        ) : (
          <>
            <span className="font-semibold tabular-nums">{formatNumber(vitals.rpm)}</span>
            <span className="text-muted-foreground">/min</span>
            <span className="text-red-400 tabular-nums">{errorPercent}%</span>
            {vitals.threatCount > 0 && (
              <>
                <span className="h-2.5 w-px bg-border" />
                <span className="text-red-400 tabular-nums">{formatNumber(vitals.threatCount)}</span>
              </>
            )}
          </>
        )}
        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    )
  }

  return (
    <div className="pointer-events-none select-none text-foreground">
      <div className="flex items-end gap-2">
        <span className="text-3xl font-semibold leading-none tracking-tight tabular-nums">
          {formatNumber(vitals.rpm)}
        </span>
        <span className="pb-1.5 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          req/min
        </span>
      </div>
      <Sparkline values={vitals.sparkline} />
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span>
          <b className="font-semibold text-red-400 tabular-nums">{errorPercent}%</b> errors
        </span>
        <span>
          <b className="font-semibold text-foreground tabular-nums">{formatNumber(vitals.threatCount)}</b> threats
        </span>
        <span>
          <b className="font-semibold text-foreground tabular-nums">{formatNumber(vitals.uniqueIps)}</b> IPs
        </span>
        <span>
          <b className="font-semibold text-foreground tabular-nums">{formatNumber(vitals.countries)}</b> countries
        </span>
      </div>
      {disconnected && <div className="mt-1 text-[10px] text-muted-foreground">Reconnecting</div>}
      {vitals.rpm === 0 && !disconnected && (
        <div className="mt-1 text-[10px] text-muted-foreground">Waiting for traffic</div>
      )}
      {vitals.droppedRecently && (
        <div className="mt-1 text-[10px] text-amber-400">
          Rate limited, {formatNumber(vitals.dropped)} events dropped
        </div>
      )}
    </div>
  )
}
