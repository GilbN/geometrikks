/**
 * Table rows for one run of back-to-back alerts in Alert history. A single
 * alert is one row that opens its alert. A longer run is a summary row
 * showing the newest alert that expands, on activation, to one full sub-row
 * per alert, the way Active decisions groups do. Each sub-row opens its own
 * alert.
 */
import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { CountryLabel } from "@/components/country-flag"
import { Badge } from "@/components/ui/badge"
import { TableCell, TableRow } from "@/components/ui/table"
import { rowActivation, stopRowActivation } from "@/components/data/row-activation"
import { AlertKindBadge } from "@/components/security/alert-kind-badge"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import { FlyToIpButton } from "@/components/map/FlyToIpButton"
import type { AlertView } from "@/lib/api"
import { alertOutcome, alertSummary, runScenarioLabel, type AlertRun } from "@/lib/crowdsec-alerts"
import { cn } from "@/lib/utils"

type Props = {
  run: AlertRun
  open: boolean
  onToggle: () => void
  onOpenAlert: (alert: AlertView) => void
}

type AlertRowProps = {
  alert: AlertView
  onOpenAlert: (alert: AlertView) => void
  /** Replaces opening the alert: the summary row of a run toggles it instead. */
  summary?: { open: boolean; label: string; onToggle: () => void }
  timeLead?: ReactNode
  scenarioLabel?: string | null
  scenarioTrail?: ReactNode
  className?: string
  timeClassName?: string
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
          {scenarioLabel ? (
            <span className="truncate text-xs text-muted-foreground">{scenarioLabel}</span>
          ) : (
            <span className="truncate font-mono text-xs" title={alert.scenario}>{alert.scenario}</span>
          )}
          <AlertKindBadge kind={alert.kind} scenario={alert.scenario} className="shrink-0" />
          {scenarioTrail}
        </span>
      </TableCell>
      <TableCell className="font-mono">
        {alert.value}
        {alert.scope === "Ip" && (
          <span {...stopRowActivation}>
            <IpBanControls
              ip={alert.value}
              badgeTitle={(decisionType) =>
                `This IP has an active ${decisionType} decision right now. It may come from a different alert.`
              }
            >
              <InspectIpButton ip={alert.value} className="ml-1" />
              <FlyToIpButton ip={alert.value} />
            </IpBanControls>
          </span>
        )}
      </TableCell>
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

export function AlertRunRows({ run: alertRun, open, onToggle, onOpenAlert }: Props) {
  const [newest] = alertRun.alerts
  const runSize = alertRun.alerts.length
  if (runSize === 1) {
    return <AlertRow alert={newest} onOpenAlert={onOpenAlert} />
  }

  return (
    <>
      <AlertRow
        alert={newest}
        onOpenAlert={onOpenAlert}
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
          />
        ))}
    </>
  )
}
