import { useEffect, useState, type ReactNode } from "react"
import { Globe, RotateCw } from "lucide-react"
import { CountryFlag } from "@/components/country-flag"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { formatNumber } from "@/lib/format-number"
import { cn } from "@/lib/utils"
import type { HourBucket } from "../lib/stats"
import { IpChip } from "./IpChip"
import { ERROR_TEXT_CLASS, ipMarks, type IpMark } from "./marks"
import type { PopupSession } from "./open-context"
import {
  axisLabels,
  formatBytes,
  formatErrorRate,
  loadSiteStats,
  type SiteStats as SiteStatsData,
  type SiteStatsResult,
  type StatsRange,
} from "./site-stats"

const CHART_WIDTH = 336
const BAR_GAP = 2

export function Chart({
  buckets,
  label,
  height = 58,
}: {
  buckets: HourBucket[]
  label: string
  height?: number
}) {
  const count = buckets.length
  const barWidth = (CHART_WIDTH - BAR_GAP * (count - 1)) / count
  const max = Math.max(1, ...buckets.map((bucket) => bucket.requests))
  const scale = (value: number) => (value / max) * (height - 2)
  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${height}`}
      preserveAspectRatio="none"
      className="block w-full"
      style={{ height }}
      role="img"
      aria-label={label}
    >
      {buckets.map((bucket, index) => {
        const x = index * (barWidth + BAR_GAP)
        const total = scale(bucket.requests)
        const errors = scale(bucket.errors)
        return (
          <g key={bucket.start.getTime()}>
            {total - errors > 0 && (
              <rect
                x={x}
                y={height - total}
                width={barWidth}
                height={total - errors}
                rx={1.5}
                className="fill-chart-1"
                opacity={0.85}
              />
            )}
            {errors > 0 && (
              <rect
                x={x}
                y={height - errors}
                width={barWidth}
                height={errors}
                rx={1}
                className="fill-destructive"
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

export function Kpi({
  value,
  label,
  alert = false,
}: {
  value: string
  label: string
  alert?: boolean
}) {
  return (
    <div>
      <div
        className={cn(
          "text-[17px] font-semibold tracking-tight tabular-nums",
          alert && "text-destructive",
        )}
      >
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

export function ListRow({
  share,
  onClick,
  title,
  children,
}: {
  share: number
  onClick?: () => void
  title?: string
  children: ReactNode
}) {
  const className = cn(
    "relative flex min-h-[26px] w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px]",
    onClick &&
      "cursor-pointer hover:bg-[var(--control-hover-bg)] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
  )
  const content = (
    <>
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0 rounded-[5px] bg-primary/12"
        style={{ width: `${share * 100}%` }}
      />
      {children}
    </>
  )
  if (!onClick) return <div className={className}>{content}</div>
  return (
    <button type="button" className={className} onClick={onClick} title={title}>
      {content}
    </button>
  )
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("relative min-w-0 flex-1 truncate", className)}>{children}</span>
}

export function ErrorCount({ count }: { count: number }) {
  return (
    <span
      className={cn(
        "relative min-w-[34px] text-right text-[11.5px] tabular-nums",
        ERROR_TEXT_CLASS,
      )}
    >
      {count > 0 ? (
        <>
          {formatNumber(count)}
          <span className="sr-only"> errors</span>
        </>
      ) : null}
    </span>
  )
}

export function Hits({ count }: { count: number }) {
  return (
    <span className="relative text-muted-foreground tabular-nums">
      {formatNumber(count)}
      <span className="sr-only"> requests</span>
    </span>
  )
}

function EmptyList() {
  return <p className="px-1.5 py-2 text-xs text-muted-foreground">Nothing logged in this range.</p>
}

type ListTab = "countries" | "paths" | "ips"

function isListTab(value: string): value is ListTab {
  return value === "countries" || value === "paths" || value === "ips"
}

function Lists({
  stats,
  marks,
  tab,
  onTabChange,
  onLookup,
}: {
  stats: SiteStatsData
  marks: Record<string, IpMark>
  tab: ListTab
  onTabChange: (tab: ListTab) => void
  onLookup: (ip: string) => void
}) {
  const share = (value: number, values: number[]) => value / Math.max(1, ...values)
  const countryHits = stats.countries.map((country) => country.hits)
  const pathHits = stats.paths.map((path) => path.hits)
  const ipHits = stats.ips.map((row) => row.hits)
  const trigger =
    "flex-none px-2.5 py-1.5 text-xs font-normal after:border-b-2 after:border-primary after:bg-transparent group-data-[orientation=horizontal]/tabs:after:bottom-[-1px] group-data-[orientation=horizontal]/tabs:after:h-0"
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (isListTab(value)) onTabChange(value)
      }}
      className="gap-2"
    >
      <TabsList
        variant="line"
        aria-label="Top traffic"
        className="h-auto w-full justify-start gap-0.5 rounded-none border-b p-0"
      >
        <TabsTrigger value="countries" className={trigger}>
          Countries
        </TabsTrigger>
        <TabsTrigger value="paths" className={trigger}>
          Paths
        </TabsTrigger>
        <TabsTrigger value="ips" className={trigger}>
          IPs
        </TabsTrigger>
      </TabsList>
      <TabsContent value="countries" className="grid gap-1">
        {stats.countries.length === 0 && <EmptyList />}
        {stats.countries.map((country) => (
          <ListRow key={country.countryCode} share={share(country.hits, countryHits)}>
            <CountryFlag code={country.countryCode} className="relative" />
            <Label>{country.countryName ?? country.countryCode}</Label>
            <ErrorCount count={country.errorHits} />
            <Hits count={country.hits} />
          </ListRow>
        ))}
      </TabsContent>
      <TabsContent value="paths" className="grid gap-1">
        {stats.paths.length === 0 && <EmptyList />}
        {stats.paths.map((path) => (
          <ListRow key={path.url} share={share(path.hits, pathHits)}>
            <Label className="font-mono text-xs">{path.url}</Label>
            <ErrorCount count={path.errorHits} />
            <Hits count={path.hits} />
          </ListRow>
        ))}
      </TabsContent>
      <TabsContent value="ips" className="grid gap-1">
        {stats.ips.length === 0 && <EmptyList />}
        {stats.ips.map((row) => (
          <ListRow
            key={row.ipAddress}
            share={share(row.hits, ipHits)}
            onClick={() => onLookup(row.ipAddress)}
            title="Look up"
          >
            <CountryFlag code={row.countryCode} className="relative" />
            <IpChip
              ip={row.ipAddress}
              mark={marks[row.ipAddress]}
              className="relative max-w-[52%] flex-none truncate"
            />
            <Label className="text-[11.5px] text-muted-foreground">
              {row.asn !== null && `AS${row.asn} ${row.asOrganization ?? ""}`}
            </Label>
            <Hits count={row.hits} />
          </ListRow>
        ))}
      </TabsContent>
      <p className="mt-0.5 text-right text-[10.5px] text-muted-foreground">
        <span className={ERROR_TEXT_CLASS}>red</span> = errors
      </p>
    </Tabs>
  )
}

export const cardClass = "gap-0 rounded-[10px] px-3 py-3"

export function RangeSwitch({
  range,
  onChange,
}: {
  range: StatsRange
  onChange: (range: StatsRange) => void
}) {
  return (
    <ToggleGroup
      type="single"
      value={range}
      onValueChange={(value) => {
        if (value === "24h" || value === "7d") onChange(value)
      }}
      aria-label="Range"
      className="ml-auto rounded-[7px] bg-muted p-0.5"
    >
      {(["24h", "7d"] as const).map((value) => (
        <ToggleGroupItem
          key={value}
          value={value}
          className="h-auto min-w-0 rounded-[5px]! px-2.5 py-0.5 text-[11.5px] font-normal text-muted-foreground hover:bg-transparent data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm"
        >
          {value === "24h" ? "24 h" : "7 d"}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** Screen 2. Reports a "no traffic" answer up, so Home can show screen 3. */
export function SiteStats({
  session,
  hosts,
  onLookup,
  onNoTraffic,
}: {
  session: PopupSession
  hosts: string[]
  onLookup: (ip: string) => void
  onNoTraffic: () => void
}) {
  const [range, setRange] = useState<StatsRange>("24h")
  const [tab, setTab] = useState<ListTab>("countries")
  const [results, setResults] = useState<Partial<Record<StatsRange, SiteStatsResult>>>({})
  const [marks, setMarks] = useState<Record<string, IpMark>>({})
  const result = results[range]
  const missing = result === undefined
  const stats = result?.kind === "stats" ? result.stats : null

  useEffect(() => {
    if (!missing) return
    let cancelled = false
    void (async () => {
      const loaded = await loadSiteStats(session.client, hosts, range, new Date())
      if (cancelled) return
      if (loaded.kind === "no-traffic") onNoTraffic()
      else setResults((previous) => ({ ...previous, [range]: loaded }))
    })()
    return () => {
      cancelled = true
    }
  }, [range, missing, hosts, session, onNoTraffic])

  useEffect(() => {
    const { access } = session
    if (!stats || (!access.crowdsec && !access.drop)) return
    let cancelled = false
    void (async () => {
      const ips = stats.ips.map((row) => row.ipAddress)
      const found = await ipMarks(session.client, ips, access, session.dropIndex)
      if (!cancelled) setMarks((previous) => ({ ...previous, ...found }))
    })()
    return () => {
      cancelled = true
    }
  }, [stats, session])

  const retry = () =>
    setResults((previous) => {
      const { [range]: _failed, ...rest } = previous
      return rest
    })

  return (
    <>
      <Card className={cardClass}>
        <div className="mb-2.5 flex items-center gap-2">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
            <Globe aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{hosts[0]}</span>
          </span>
          <RangeSwitch range={range} onChange={setRange} />
        </div>
        {result?.kind === "error" ? (
          <div className="grid justify-items-start gap-2 text-[12.5px] text-muted-foreground">
            <p>{result.failure.detail ?? "Site stats didn't load."}</p>
            <Button variant="outline" size="sm" onClick={retry}>
              <RotateCw />
              Try again
            </Button>
          </div>
        ) : stats ? (
          <>
            <div className="grid grid-cols-4 gap-2">
              <Kpi value={formatNumber(stats.totals.requests)} label="requests" />
              <Kpi value={formatNumber(stats.distinctIps)} label="unique IPs" />
              <Kpi
                value={formatErrorRate(stats.totals.errorRate)}
                label="errors"
                alert={stats.totals.errors > 0}
              />
              <Kpi value={formatBytes(stats.totals.bytes)} label="sent" />
            </div>
            <div className="mt-2.5">
              <Chart
                buckets={stats.buckets}
                label={`Requests per ${range === "24h" ? "hour" : "6 hours"}, errors in red`}
              />
              <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
                {axisLabels(stats.start, stats.end, range).map((label, index) => (
                  <span key={index}>{label}</span>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="grid gap-2.5" aria-busy="true" aria-label="Loading site stats">
            <Skeleton className="h-10" />
            <Skeleton className="h-[58px]" />
          </div>
        )}
      </Card>
      {stats && (
        <Card className={cn(cardClass, "pt-2")}>
          <Lists stats={stats} marks={marks} tab={tab} onTabChange={setTab} onLookup={onLookup} />
        </Card>
      )}
    </>
  )
}
