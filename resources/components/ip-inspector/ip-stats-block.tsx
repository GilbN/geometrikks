import { Bar, BarChart, ReferenceLine, XAxis } from "recharts"
import type { IpProfileResponse } from "@/generated/api/types.gen"
import { ChartContainer, type ChartConfig } from "@/components/ui/chart"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatBytes, formatNumber } from "@/lib/api"
import { formatTs } from "@/lib/datetime"
import { formatDurationOrNa } from "@/lib/timing"

const SPARK_CONFIG = { hits: { label: "Requests", color: "var(--chart-1)" } } satisfies ChartConfig

// Same palette the analytics status chart uses: 2xx teal, 3xx gray, 4xx amber, 5xx red.
const STATUS_SEGMENTS = [
  { key: "status2xx", className: "bg-[var(--chart-1)]", label: "2xx" },
  { key: "status3xx", className: "bg-muted-foreground/60", label: "3xx" },
  { key: "status4xx", className: "bg-amber-500", label: "4xx" },
  { key: "status5xx", className: "bg-destructive", label: "5xx" },
] as const

function Tile({ value, label, hint }: { value: string; label: string; hint?: string }) {
  const tile = (
    <div className="min-w-0">
      <div className="truncate text-base font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
  if (!hint) return tile
  return (
    <Tooltip>
      <TooltipTrigger asChild>{tile}</TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

export function IpStatsBlock({
  profile,
  banCreatedAt,
}: {
  profile: IpProfileResponse
  banCreatedAt: string | null
}) {
  const total = profile.totalRequests
  if (total === 0) {
    return <p className="text-sm text-muted-foreground">No requests in this range.</p>
  }
  const peak = profile.peak
  // API timestamps carry a +00:00 offset; bucketFloor returns "...Z". Same
  // string form on both sides or the ReferenceLine never matches a bar.
  const series = profile.series.map((b) => ({ ...b, timestamp: new Date(b.timestamp).toISOString() }))
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-3">
        <Tile value={formatNumber(total)} label="requests" />
        <Tile value={formatBytes(profile.totalBytes)} label="sent" />
        <Tile
          value={formatDurationOrNa(profile.avgRequestTime)}
          label="avg time"
          hint={`p95 ${formatDurationOrNa(profile.p95RequestTime)} from ${formatNumber(profile.timedRequests)} timed requests`}
        />
        <Tile
          value={peak ? formatTs(peak.timestamp, profile.granularity) : "n/a"}
          label={peak ? `peak, ${formatNumber(peak.hits)}` : "peak"}
        />
      </div>

      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-label="Status split">
        {STATUS_SEGMENTS.map((s) => {
          const share = (profile[s.key] / total) * 100
          return share > 0 ? (
            <div key={s.key} className={s.className} style={{ width: `${share}%` }} title={`${s.label}: ${formatNumber(profile[s.key])}`} />
          ) : null
        })}
      </div>

      <ChartContainer config={SPARK_CONFIG} className="h-16 w-full">
        <BarChart data={series} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} barCategoryGap={1}>
          <XAxis dataKey="timestamp" hide />
          <Bar dataKey="hits" fill="var(--color-hits)" radius={1} isAnimationActive={false} />
          {banCreatedAt && (
            <ReferenceLine x={banCreatedAt} stroke="var(--destructive)" strokeDasharray="3 3" />
          )}
        </BarChart>
      </ChartContainer>

      <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>first {profile.firstSeen ? formatTs(profile.firstSeen) : "n/a"}</span>
        <span>last {profile.lastSeen ? formatTs(profile.lastSeen) : "n/a"}</span>
      </div>
    </div>
  )
}
