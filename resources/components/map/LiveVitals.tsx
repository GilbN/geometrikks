/**
 * Ambient live readout. Desktop renders a cluster over the map's top-left;
 * mobile renders the same numbers as a pill that opens the feed sheet.
 */
import { ChevronUp } from "lucide-react"
import { useLiveFeedState, useLiveVitals } from "@/lib/live-traffic/context"
import { formatNumber } from "@/lib/api"
import { cn } from "@/lib/utils"

const SPARKLINE_WIDTH = 176
const SPARKLINE_HEIGHT = 26

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const peak = Math.max(1, ...values)
  const step = SPARKLINE_WIDTH / (values.length - 1)
  const points = values.map((value, index) => [
    index * step,
    SPARKLINE_HEIGHT - 1 - (value / peak) * (SPARKLINE_HEIGHT - 2),
  ] as const)
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")
  // Close the shape along the baseline so the line can carry a soft area fill.
  const area = `${line} ${SPARKLINE_WIDTH},${SPARKLINE_HEIGHT} 0,${SPARKLINE_HEIGHT}`

  return (
    <svg width={SPARKLINE_WIDTH} height={SPARKLINE_HEIGHT} className="block" aria-hidden>
      <polygon points={area} fill="var(--geo-cyan)" opacity={0.14} />
      <polyline points={line} fill="none" stroke="var(--geo-cyan)" strokeWidth={1.4} opacity={0.9} />
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
  const feedState = useLiveFeedState()
  const disconnected = feedState !== "connected"
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

  // The panel matches the strips and the timeline: a quiet glass card, so the
  // numbers stay readable over any map style instead of floating on the tiles.
  return (
    <div className="pointer-events-none select-none rounded-md border bg-background/85 px-3 py-2.5 text-foreground backdrop-blur">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            disconnected ? "bg-muted-foreground" : "bg-geo-cyan animate-pulse",
          )}
        />
        <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {disconnected ? "Reconnecting" : "Live"}
        </span>
      </div>
      <div className="mt-1.5 flex items-end gap-2">
        <span className="text-3xl font-semibold leading-none tracking-tight tabular-nums">
          {formatNumber(vitals.rpm)}
        </span>
        <span className="pb-1 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          req/min
        </span>
      </div>
      <div className="mt-1.5">
        <Sparkline values={vitals.sparkline} />
      </div>
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
