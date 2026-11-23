/**
 * The Security summary: active decisions with their split, alerts per day
 * and the top scenarios. One strip on desktop; on a phone the decisions
 * take the full width and the other two share the row below.
 */
import { Fragment } from "react"
import { Hand, ShieldBan, Timer } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { CrowdSecStatusResponse } from "@/lib/api"
import { formatNumber } from "@/lib/format-number"
import { useCrowdsecAlertsPerDay, useCrowdsecStats, useCrowdsecStatus } from "@/lib/queries"
import { scenarioText } from "@/lib/scenario-name"
import {
  alertTotalText,
  barLabel,
  expiryPhrase,
  scenarioRow,
  originPhrases,
  splitPhrases,
  weekday,
} from "@/lib/security-summary"
import { cn } from "@/lib/utils"

const ALERT_DAYS = 7
const MANUAL_TYPE_DOT: Record<string, string> = { ban: "bg-red-500", captcha: "bg-amber-500" }
const CAPPED_NOTE = "More alerts than one request reads, so some days count short."

const LABEL_CLASS =
  "text-[11px] font-semibold uppercase tracking-[0.08em] whitespace-nowrap text-muted-foreground"
// A card of its own on a phone, a column of one strip on desktop.
const PART_CLASS =
  "min-w-0 gap-0 rounded-none bg-transparent shadow-none ring-0 border-l border-border first:border-l-0 px-[18px] py-3.5 phone:rounded-xl phone:border-l-0 phone:bg-card phone:ring-1 phone:shadow-[var(--shadow-card)]"

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
  const lines = stats
    ? [
        { icon: ShieldBan, tint: "text-red-500", phrases: splitPhrases(stats.split) },
        {
          icon: Timer,
          tint: "text-amber-500",
          phrases: [expiryPhrase(stats.expiringSoon, stats.expiringSoonHours)],
        },
        { icon: Hand, tint: "text-primary", phrases: originPhrases(stats.byOrigin) },
      ]
    : []

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
            <span className="text-xs text-muted-foreground">active</span>
          </div>
          {stats.total > 0 ? (
            <ul className="mt-[9px] flex flex-col gap-[7px] text-[13px] phone:mt-2 phone:gap-1.5 phone:text-[12.5px]">
              {lines.map(({ icon: Icon, tint, phrases }) => (
                <li key={tint} className="flex min-w-0 items-center gap-2">
                  <Icon aria-hidden className={cn("size-[15px] shrink-0", tint)} />
                  <span className="min-w-0">
                    {phrases.map((part, index) => (
                      <Fragment key={part.words}>
                        {index > 0 && ", "}
                        {part.count === 0 ? (
                          "None"
                        ) : (
                          <span className="font-semibold tabular-nums">
                            {formatNumber(part.count)}
                          </span>
                        )}{" "}
                        {part.words}
                      </Fragment>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Unavailable>No active decisions.</Unavailable>
          )}
        </>
      ) : isPending ? (
        <div className="mt-2 space-y-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-4 w-52" />
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-4 w-56" />
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
  const topDay = Math.max(...(counts?.days.map((day) => day.count) ?? []), 1)

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
        <ol
          className="mt-3 grid grid-cols-7 phone:mt-2.5"
          title={counts.capped ? CAPPED_NOTE : undefined}
        >
          {counts.days.map((day, index) => {
            const today = index === counts.days.length - 1
            const names = weekday(day.date)
            return (
              <li
                key={day.date}
                aria-label={`${today ? "Today" : names.short}: ${formatNumber(day.count)}`}
                className="flex flex-col items-center gap-1 text-[11px] phone:text-[10px]"
              >
                <span
                  aria-hidden
                  className={cn(
                    "tabular-nums",
                    today ? "font-semibold" : "text-muted-foreground",
                    !day.count && "opacity-50",
                  )}
                >
                  {barLabel(day.count)}
                </span>
                <span
                  aria-hidden
                  className="relative h-14 w-2 rounded-full bg-[color-mix(in_oklab,var(--muted-foreground)_14%,transparent)] phone:h-[46px] phone:w-1.5"
                >
                  <span
                    className={cn(
                      "absolute inset-x-0 bottom-0 rounded-full bg-chart-5",
                      !today && "opacity-60",
                    )}
                    style={{ height: `${(day.count / topDay) * 100}%` }}
                  />
                </span>
                <span aria-hidden className={today ? "font-semibold" : "text-muted-foreground"}>
                  <span className="phone:hidden">{names.short}</span>
                  <span className="hidden phone:inline">{names.initial}</span>
                </span>
              </li>
            )
          })}
        </ol>
      ) : isPending ? (
        <Skeleton className="mt-3 h-[88px] w-full phone:mt-2.5 phone:h-[78px]" />
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
    <Card className={cn(PART_CLASS, "phone:px-1.5 phone:pt-3 phone:pb-2.5")}>
      <h2 className={cn(LABEL_CLASS, "mb-2 phone:mx-1.5")}>Top scenarios</h2>
      {stats ? (
        scenarios.length > 0 ? (
          <ol className="flex flex-col gap-[9px] phone:mx-1.5 phone:gap-2">
            {scenarios.map((scenario, index) => {
              const row = scenarioRow(scenario.scenario)
              return (
                <li
                  key={scenario.scenario}
                  title={scenarioText(scenario.scenario)}
                  className={cn(
                    "min-w-0 text-[13px] phone:text-xs",
                    index >= 4 && "hidden",
                    index === 3 && "phone:hidden",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    {row.manualType && (
                      <Badge
                        variant="outline"
                        className="h-[17px] gap-1 px-1.5 text-[10.5px] text-muted-foreground"
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 rounded-full",
                            MANUAL_TYPE_DOT[row.manualType] ?? "bg-muted-foreground",
                          )}
                        />
                        {row.manualType}
                      </Badge>
                    )}
                    <span
                      className={cn(
                        "min-w-0 truncate",
                        !row.manualType && "font-mono text-[12.5px] phone:font-sans phone:text-xs",
                      )}
                    >
                      {row.label}
                    </span>
                    <span className="ml-auto shrink-0 font-semibold tabular-nums">
                      {formatNumber(scenario.count)}
                    </span>
                  </div>
                  <div
                    aria-hidden
                    className="mt-1 h-1 rounded-full bg-[color-mix(in_oklab,var(--muted-foreground)_14%,transparent)]"
                  >
                    <div
                      className="h-full rounded-full bg-chart-5"
                      style={{ width: `${(scenario.count / top) * 100}%` }}
                    />
                  </div>
                </li>
              )
            })}
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
