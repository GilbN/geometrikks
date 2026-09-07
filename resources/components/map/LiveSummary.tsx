/**
 * The reading half of the live surfaces: how much traffic, what shape it has,
 * and where it comes from. Shared by the desktop rail and the phone sheet so
 * both describe the same window the same way.
 */
import { Minus, TrendingDown, TrendingUp } from "lucide-react"
import { useLiveFeedState, useLiveVitals } from "@/lib/live-traffic/context"
import { PACKET_COLORS } from "@/lib/live-traffic/classify"
import { smooth, trendPercent, type LiveSummary as Summary } from "@/lib/live-traffic/summary"
import { formatNumber } from "@/lib/api"
import { cn } from "@/lib/utils"

const SPARKLINE_WIDTH = 200
const SPARKLINE_HEIGHT = 28

export function Sparkline({
  values,
  className = "block h-7 w-full",
}: {
  values: number[]
  className?: string
}) {
  if (values.length < 2) return <div className={className} />
  // Per-second counts of bursty traffic draw a comb, not a rhythm.
  const series = smooth(values)
  const peak = Math.max(1, ...series)
  const step = SPARKLINE_WIDTH / (series.length - 1)
  const points = series.map((value, index) => [
    index * step,
    SPARKLINE_HEIGHT - 1 - (value / peak) * (SPARKLINE_HEIGHT - 2),
  ] as const)
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")
  // Close the shape along the baseline so the line can carry a soft area fill.
  const area = `${line} ${SPARKLINE_WIDTH},${SPARKLINE_HEIGHT} 0,${SPARKLINE_HEIGHT}`

  return (
    <svg
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden
    >
      <polygon points={area} fill="var(--primary)" opacity={0.14} />
      <polyline points={line} fill="none" stroke="var(--primary)" strokeWidth={1.4} opacity={0.9} />
    </svg>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * Requests per minute, the sparkline, and how the window is trending. Dense
 * lays the sparkline beside the number instead of under it, which buys the
 * phone sheet a couple of extra feed rows.
 */
function Rate({ dense }: { dense: boolean }) {
  const vitals = useLiveVitals()
  const feedState = useLiveFeedState()
  const disconnected = feedState !== "connected"
  const trend = trendPercent(vitals.sparkline)

  // Always rendered, never conditionally mounted: a badge that comes and goes
  // as traffic wobbles around flat reads as a glitch and shifts the row.
  const trendBadge = (
    <span
      className={cn(
        "flex w-12 shrink-0 items-center justify-end gap-0.5 text-[10px] font-medium tabular-nums",
        trend === null || trend === 0
          ? "text-muted-foreground"
          : trend > 0
            ? "text-primary"
            : "text-muted-foreground",
      )}
      title={
        trend === null
          ? "No earlier traffic in this window to compare against"
          : `${trend > 0 ? "Up" : trend < 0 ? "Down" : "Level"} ${Math.abs(trend)}% against the first half of the window`
      }
    >
      {trend === null ? null : (
        <>
          {trend > 0 ? (
            <TrendingUp className="h-3 w-3" />
          ) : trend < 0 ? (
            <TrendingDown className="h-3 w-3" />
          ) : (
            <Minus className="h-3 w-3" />
          )}
          {Math.abs(trend)}%
        </>
      )}
    </span>
  )

  const reading = (
    <span className="flex items-baseline gap-2">
      <span
        className={cn(
          "font-semibold leading-none tracking-tight tabular-nums",
          dense ? "text-2xl" : "text-3xl",
        )}
      >
        {formatNumber(vitals.rpm)}
      </span>
      <span className="text-[9px] uppercase tracking-[0.1em] text-muted-foreground">req/min</span>
    </span>
  )

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            disconnected ? "bg-muted-foreground" : "bg-primary animate-pulse",
          )}
        />
        <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {disconnected ? (feedState === "paused" ? "Live feed paused" : "Reconnecting") : "Last 5 minutes"}
        </span>
      </div>

      {dense ? (
        <div className="mt-1 flex items-center gap-3">
          {reading}
          <Sparkline values={vitals.sparkline} className="block h-6 min-w-0 flex-1" />
          {trendBadge}
        </div>
      ) : (
        <>
          <div className="mt-1.5 flex items-end justify-between gap-2">
            {reading}
            {trendBadge}
          </div>
          <div className="mt-1">
            <Sparkline values={vitals.sparkline} />
          </div>
        </>
      )}

      {vitals.droppedRecently && (
        <div className="mt-1 text-[10px] text-amber-400">
          Rate limited, {formatNumber(vitals.dropped)} events dropped
        </div>
      )}
    </div>
  )
}

/** The shape of the traffic: a wave of 404s reads before any number does. */
function ResponseMix({ summary }: { summary: Summary }) {
  return (
    <div>
      <SectionLabel>Response mix</SectionLabel>
      {summary.total === 0 ? (
        <p className="text-[10px] text-muted-foreground">Waiting for traffic</p>
      ) : (
        <>
          <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted">
            {summary.mix.map(({ status, share }) => (
              <span
                key={status}
                style={{ width: `${share * 100}%`, background: PACKET_COLORS[status] }}
              />
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] tabular-nums">
            {summary.mix.map(({ status, share }) => (
              <span key={status} className="text-muted-foreground">
                <b className="font-semibold" style={{ color: PACKET_COLORS[status] }}>
                  {Math.round(share * 100)}%
                </b>{" "}
                {status}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Busiest countries in the live window, which is not the all-time top IPs the
 * controls panel lists. Dense drops the proportion bars for a single line of
 * chips, since four bar rows cost more height than a phone can spare.
 */
function TopOrigins({ summary, dense }: { summary: Summary; dense: boolean }) {
  if (dense) {
    return (
      <div>
        <SectionLabel>Top origins</SectionLabel>
        {summary.origins.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">No origins yet</p>
        ) : (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {summary.origins.map(({ country, count }) => (
              <span key={country} className="text-muted-foreground">
                <span className="font-mono">{country}</span>{" "}
                <b className="font-semibold tabular-nums text-foreground">{formatNumber(count)}</b>
              </span>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <SectionLabel>Top origins</SectionLabel>
      {summary.origins.length === 0 ? (
        <p className="text-[10px] text-muted-foreground">No origins yet</p>
      ) : (
        <div className="flex flex-col gap-1">
          {summary.origins.map(({ country, count, share }) => (
            <div key={country} className="flex items-center gap-2 text-[10px]">
              <span
                className={cn(
                  "w-6 shrink-0 font-mono",
                  country === "??" ? "text-muted-foreground/60" : "text-muted-foreground",
                )}
                title={country === "??" ? "No GeoIP match" : undefined}
              >
                {country}
              </span>
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary/70"
                  style={{ width: `${share * 100}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
                {formatNumber(count)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function LiveSummary({
  summary,
  dense = false,
}: {
  summary: Summary
  /** Tightened for the phone sheet, where the feed needs the height more. */
  dense?: boolean
}) {
  return (
    <div className={cn("flex flex-col", dense ? "gap-2" : "gap-3")}>
      <Rate dense={dense} />
      <ResponseMix summary={summary} />
      <TopOrigins summary={summary} dense={dense} />
    </div>
  )
}
