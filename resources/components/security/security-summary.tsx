/**
 * The Security summary: active decisions with their split, alerts per day
 * and the top scenarios. One strip on desktop; on a phone the decisions
 * take the full width and the other two share the row below.
 */
import { Bar, BarChart, Cell, LabelList, XAxis } from "recharts"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { ChartContainer, type ChartConfig } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import type { CrowdSecStatusResponse } from "@/lib/api"
import { formatNumber } from "@/lib/format-number"
import { useCrowdsecAlertsPerDay, useCrowdsecStats, useCrowdsecStatus } from "@/lib/queries"
import { scenarioName, scenarioText } from "@/lib/scenario-name"
import {
  alertTotalText,
  barLabel,
  dayOfMonth,
  expiryText,
  setByHandCount,
  splitParts,
} from "@/lib/security-summary"
import { cn } from "@/lib/utils"

const ALERT_DAYS = 7
const CAPPED_NOTE = "More alerts than one request reads, so some days count short."

const LABEL_CLASS =
  "text-[11px] font-semibold uppercase tracking-[0.08em] whitespace-nowrap text-muted-foreground"
// A card of its own on a phone, a column of one strip on desktop.
const PART_CLASS =
  "min-w-0 gap-0 rounded-none bg-transparent shadow-none ring-0 border-l border-border first:border-l-0 px-[18px] py-3.5 phone:rounded-xl phone:border-l-0 phone:bg-card phone:ring-1 phone:shadow-[var(--shadow-card)]"

const ALERT_CHART_CONFIG = {
  count: { label: "Alerts", color: "var(--chart-5)" },
} satisfies ChartConfig

/** "LAPI connected" while the LAPI answers. The page shows its banner instead
 *  while it does not, so this renders nothing then. */
export function LapiPill({
  status,
  className,
  detail = false,
}: {
  status: CrowdSecStatusResponse | undefined
  className?: string
  /** Adds whether ban and unban work. */
  detail?: boolean
}) {
  if (!status?.enabled || !status.lapiReachable) return null
  return (
    <Badge variant="outline" className={cn("rounded-full font-medium", className)}>
      <span aria-hidden className="size-2 rounded-full bg-emerald-400" />
      LAPI connected
      {detail && (
        <span className="font-normal text-muted-foreground">
          <span className="sr-only">, </span>
          {status.writeEnabled ? "ban and unban enabled" : "read-only (no machine credentials)"}
        </span>
      )}
    </Badge>
  )
}

export function SecuritySummary() {
  const { data: status } = useCrowdsecStatus()
  return (
    <section
      aria-label="Security summary"
      className="grid grid-cols-[1fr_1.25fr_1.15fr] overflow-hidden rounded-xl bg-card shadow-[var(--shadow-card)] ring-1 ring-border phone:grid-cols-2 phone:gap-3 phone:overflow-visible phone:rounded-none phone:bg-transparent phone:shadow-none phone:ring-0"
    >
      <DecisionsPart status={status} />
      <AlertsPart writeEnabled={status?.writeEnabled === true} />
      <ScenariosPart />
    </section>
  )
}

function Unavailable({ children = "Unavailable" }: { children?: React.ReactNode }) {
  return <p className="mt-3 text-xs text-muted-foreground">{children}</p>
}

function DecisionsPart({ status }: { status: CrowdSecStatusResponse | undefined }) {
  const { data: stats, isPending } = useCrowdsecStats()
  const setByHand = stats ? `${formatNumber(setByHandCount(stats.byOrigin))} set by hand` : null
  const parts = stats ? splitParts(stats.split) : []
  const expiry = stats ? expiryText(stats.total, stats.expiringSoon, stats.expiringSoonHours) : null

  return (
    <Card className={cn(PART_CLASS, "phone:col-span-2 phone:px-3.5 phone:py-3")}>
      <div className="flex min-h-6 items-center gap-2">
        <h2 className={LABEL_CLASS}>Active decisions</h2>
        <LapiPill
          status={status}
          className="ml-auto hidden h-6 gap-1.5 px-2.5 text-[11.5px] phone:inline-flex"
        />
      </div>
      {stats ? (
        <>
          <div className="mt-1.5 flex items-baseline gap-2 phone:mt-1">
            <span className="text-[26px] font-semibold tracking-[-0.02em] tabular-nums phone:text-2xl">
              {formatNumber(stats.total)}
            </span>
            {expiry && <span className="text-xs text-muted-foreground">{expiry}</span>}
            {stats.total > 0 && (
              <span className="ml-auto hidden text-xs whitespace-nowrap text-muted-foreground phone:inline">
                {setByHand}
              </span>
            )}
          </div>
          <div
            aria-hidden
            className="mt-2.5 mb-2 flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted phone:mt-[9px]"
          >
            {parts.map((part) => (
              <span
                key={part.key}
                className={cn("min-w-1", part.className)}
                style={{ flex: part.count }}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs whitespace-nowrap text-muted-foreground">
            {parts.map((part) => (
              <span key={part.key} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2 rounded-full", part.className)} />
                {part.label}
              </span>
            ))}
            {stats.total > 0 && <span className="ml-auto phone:hidden">{setByHand}</span>}
          </div>
        </>
      ) : isPending ? (
        <div className="mt-2 space-y-2.5">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-3 w-48" />
        </div>
      ) : (
        <Unavailable />
      )}
    </Card>
  )
}

function AlertsPart({ writeEnabled }: { writeEnabled: boolean }) {
  const { data, isPending, isError } = useCrowdsecAlertsPerDay(ALERT_DAYS)
  // A failed refresh keeps the last week in the cache, which would read as current.
  const counts = writeEnabled && !isError ? data : undefined
  const series = counts?.days.map((day) => ({ ...day, day: dayOfMonth(day.date) })) ?? []

  return (
    <Card className={cn(PART_CLASS, "phone:px-3 phone:pt-3 phone:pb-2.5")}>
      <div className="flex items-center gap-2">
        <h2 className={cn(LABEL_CLASS, "min-w-0 truncate")}>
          Alerts, <span className="phone:hidden">last </span>
          {ALERT_DAYS} days
        </h2>
        {counts && (
          <span
            className="ml-auto shrink-0 text-[13px] font-semibold tabular-nums"
            title={counts.capped ? CAPPED_NOTE : undefined}
          >
            {alertTotalText(counts.total, counts.capped)}
            {counts.capped && <span className="sr-only">. {CAPPED_NOTE}</span>}
          </span>
        )}
      </div>
      {!writeEnabled ? (
        <Unavailable>Alert history needs CrowdSec machine credentials.</Unavailable>
      ) : counts ? (
        <ChartContainer
          config={ALERT_CHART_CONFIG}
          className="mt-2 aspect-auto h-20 w-full phone:h-[76px]"
          title={counts.capped ? CAPPED_NOTE : undefined}
          aria-label={counts.days.map((day) => `${day.date}: ${day.count}`).join(", ")}
          role="img"
        >
          <BarChart
            data={series}
            margin={{ top: 14, right: 0, bottom: 0, left: 0 }}
            barCategoryGap="16%"
          >
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              interval={0}
              tickMargin={3}
              height={18}
              fontSize={10}
            />
            <Bar
              dataKey="count"
              fill="var(--color-count)"
              radius={3}
              minPointSize={2}
              isAnimationActive={false}
            >
              {series.map((point) => (
                <Cell key={point.date} fillOpacity={point.count ? 0.9 : 0.25} />
              ))}
              <LabelList
                dataKey="count"
                position="top"
                offset={4}
                fontSize={10}
                className="fill-muted-foreground"
                formatter={(value: unknown) => barLabel(Number(value))}
              />
            </Bar>
          </BarChart>
        </ChartContainer>
      ) : isPending ? (
        <Skeleton className="mt-2 h-20 w-full phone:h-[76px]" />
      ) : (
        <Unavailable />
      )}
    </Card>
  )
}

function ScenariosPart() {
  const { data: stats, isPending } = useCrowdsecStats()
  const scenarios = stats?.topScenarios ?? []
  const top = Math.max(...scenarios.map((scenario) => scenario.count), 1)

  return (
    <Card className={cn(PART_CLASS, "phone:px-1.5 phone:pt-3 phone:pb-2")}>
      <h2 className={cn(LABEL_CLASS, "mb-1.5 phone:mx-1.5")}>Top scenarios</h2>
      {stats ? (
        scenarios.length > 0 ? (
          <ol>
            {scenarios.map((scenario, index) => (
              <li
                key={scenario.scenario}
                title={scenarioText(scenario.scenario)}
                className={cn(
                  "relative flex h-[25px] min-w-0 items-center gap-2 px-2 text-[12.5px] phone:h-[26px] phone:px-1.5 phone:text-xs",
                  index >= 4 && "hidden",
                  index === 3 && "phone:hidden",
                )}
              >
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 rounded-md bg-[color-mix(in_oklab,var(--chart-5)_20%,transparent)]"
                  style={{ width: `${(scenario.count / top) * 100}%` }}
                />
                <span className="relative min-w-0 truncate font-mono phone:font-sans">
                  {scenarioName(scenario.scenario).name}
                </span>
                <span className="relative ml-auto font-medium tabular-nums">
                  {formatNumber(scenario.count)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="phone:mx-1.5">
            <Unavailable>No active decisions.</Unavailable>
          </div>
        )
      ) : isPending ? (
        <div className="space-y-1.5 phone:mx-1.5">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-5 w-full" />
          ))}
        </div>
      ) : (
        <div className="phone:mx-1.5">
          <Unavailable />
        </div>
      )}
    </Card>
  )
}
