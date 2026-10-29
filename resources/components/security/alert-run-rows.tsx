/**
 * Table rows for one run of back-to-back alerts in Alert history. A single
 * alert is one row that opens its alert. A longer run is a summary row
 * showing the newest alert that expands, on activation, to one full sub-row
 * per alert, the way Active decisions groups do. Each sub-row opens its own
 * alert.
 */
import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { CountryFlag, CountryLabel } from "@/components/country-flag"
import { Badge } from "@/components/ui/badge"
import { TableCell, TableRow } from "@/components/ui/table"
import { rowActivation } from "@/components/data/row-activation"
import { ScenarioLabel } from "@/components/crowdsec/scenario-label"
import { AlertKindBadge } from "@/components/security/alert-kind-badge"
import { IpActionsMenu } from "@/components/ip-actions/ip-actions-menu"
import { IpLabel } from "@/components/ip-actions/ip-label"
import type { AlertView } from "@/lib/api"
import { alertOutcome, alertSummary, runScenarioLabel, type AlertRun } from "@/lib/crowdsec-alerts"
import { formatRowTime } from "@/lib/row-time"
import { cn } from "@/lib/utils"

type Props = {
  run: AlertRun
  open: boolean
  /** One cell per row on two lines, for a narrow card. */
  narrow?: boolean
  onToggle: () => void
  onOpenAlert: (alert: AlertView) => void
}

type AlertRowProps = {
  alert: AlertView
  onOpenAlert: (alert: AlertView) => void
  /** Makes the row toggle its run instead of opening the alert. */
  summary?: { open: boolean; label: string; onToggle: () => void }
  timeLead?: ReactNode
  scenarioLabel?: string | null
  scenarioTrail?: ReactNode
  className?: string
  timeClassName?: string
  narrow?: boolean
  /** A sub-row of an expanded run, which shares the run's source. */
  inRun?: boolean
}

function AlertRow({
  alert,
  onOpenAlert,
  summary,
  timeLead,
  scenarioLabel,
  scenarioTrail,
  className,
  timeClassName,
  narrow = false,
  inRun = false,
}: AlertRowProps) {
  const outcome = alertOutcome(alert)
  const activation = summary
    ? {
        "aria-expanded": summary.open,
        "aria-label": summary.label,
        ...rowActivation<HTMLTableRowElement>(summary.onToggle),
      }
    : alert.id !== null
      ? {
          "aria-label": `Alert ${alert.id}, ${alert.scenario}, ${alert.value}`,
          ...rowActivation<HTMLTableRowElement>(() => onOpenAlert(alert)),
        }
      : { "aria-label": `Alert, ${alert.scenario}, ${alert.value}`, className: undefined }
  const scenario = scenarioLabel ? (
    <span className="truncate text-xs text-muted-foreground">{scenarioLabel}</span>
  ) : (
    <ScenarioLabel scenario={alert.scenario} />
  )
  const source = alert.scope === "Ip" ? (
    <>
      <IpLabel
        ip={alert.value}
        className={narrow ? "truncate" : undefined}
        title={(decisionType) =>
          `This IP has an active ${decisionType} decision right now. It may come from a different alert.`
        }
      />
      <IpActionsMenu
        ip={alert.value}
        countryCode={alert.countryCode}
        countryName={alert.countryName}
        asOrganization={alert.asName}
      />
    </>
  ) : (
    <span className="min-w-0 truncate">{alert.value}</span>
  )

  if (narrow) {
    return (
      <TableRow {...activation} className={cn(activation?.className, className)}>
        <TableCell className={cn("py-2.5", inRun && "pl-7")}>
          <div className="flex min-w-0 items-center gap-1.5">
            {timeLead}
            <span className="flex min-w-0 flex-1 items-center">{scenario}</span>
            <AlertKindBadge kind={alert.kind} scenario={alert.scenario} className="shrink-0" />
            {scenarioTrail}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
            <span className="shrink-0 whitespace-nowrap text-muted-foreground">{formatRowTime(alert.createdAt)}</span>
            <span className={cn("min-w-16 flex-1 truncate", outcome.muted && "text-muted-foreground")}>{outcome.text}</span>
            {/* A run shares one source, so its sub-rows leave it to the summary row. */}
            {!inRun && (
              <span className="flex min-w-0 max-w-[65%] items-center gap-1.5 font-mono">
                <CountryFlag code={alert.countryCode} name={alert.countryName} standalone />
                {source}
              </span>
            )}
          </div>
        </TableCell>
      </TableRow>
    )
  }

  return (
    <TableRow
      {...activation}
      className={cn(activation?.className, className)}
    >
      <TableCell className={cn("whitespace-nowrap text-muted-foreground", timeClassName)}>
        {timeLead}
        {new Date(alert.createdAt).toLocaleString()}
      </TableCell>
      <TableCell className="max-w-[280px]" title={scenarioLabel ? undefined : alertSummary(alert.message)}>
        <span className="flex items-center gap-1.5">
          {scenario}
          <AlertKindBadge kind={alert.kind} scenario={alert.scenario} className="shrink-0" />
          {scenarioTrail}
        </span>
      </TableCell>
      <TableCell className="font-mono">{source}</TableCell>
      <TableCell>
        {alert.countryCode || alert.countryName ? (
          <CountryLabel code={alert.countryCode} name={alert.countryName} />
        ) : "-"}
      </TableCell>
      <TableCell className="max-w-[160px] truncate" title={alert.asName ?? undefined}>
        {alert.asName ?? "-"}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {alert.machineId ?? "-"}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {alert.eventsCount}
      </TableCell>
      <TableCell className={cn(outcome.muted && "text-muted-foreground")}>
        {outcome.text}
      </TableCell>
    </TableRow>
  )
}

export function AlertRunRows({ run: alertRun, open, narrow = false, onToggle, onOpenAlert }: Props) {
  const [newest] = alertRun.alerts
  const runSize = alertRun.alerts.length
  if (runSize === 1) {
    return <AlertRow alert={newest} onOpenAlert={onOpenAlert} narrow={narrow} />
  }

  return (
    <>
      <AlertRow
        alert={newest}
        onOpenAlert={onOpenAlert}
        narrow={narrow}
        summary={{ open, label: `${runSize} alerts from ${newest.value}`, onToggle }}
        scenarioLabel={runScenarioLabel(alertRun)}
        timeLead={
          <ChevronRight
            aria-hidden
            className={cn("mr-1 inline size-3.5 align-middle text-muted-foreground transition-transform", open && "rotate-90")}
          />
        }
        scenarioTrail={
          <Badge variant="secondary" className="shrink-0 tabular-nums">×{runSize}</Badge>
        }
      />
      {open &&
        alertRun.alerts.map((alert, index) => (
          <AlertRow
            key={alert.id ?? index}
            alert={alert}
            onOpenAlert={onOpenAlert}
            className="bg-muted/30 hover:bg-muted/40"
            timeClassName="pl-9"
            narrow={narrow}
            inRun
          />
        ))}
    </>
  )
}
