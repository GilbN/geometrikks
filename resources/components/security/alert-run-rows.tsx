/**
 * Table rows for one run of back-to-back alerts in Alert history. A single
 * alert is one row. A longer run is a summary row showing the newest alert,
 * with a toggle that expands one full sub-row per alert. Every row opens its
 * own alert.
 */
import { useState, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { CountryLabel } from "@/components/country-flag"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  onOpenAlert: (alert: AlertView) => void
  onFilterScenario: (scenario: string) => void
}

type AlertRowProps = {
  alert: AlertView
  onOpenAlert: (alert: AlertView) => void
  onFilterScenario: (scenario: string) => void
  timeLead?: ReactNode
  scenarioLabel?: string | null
  scenarioTrail?: ReactNode
  className?: string
  timeClassName?: string
}

function AlertRow({
  alert,
  onOpenAlert,
  onFilterScenario,
  timeLead,
  scenarioLabel,
  scenarioTrail,
  className,
  timeClassName,
}: AlertRowProps) {
  const outcome = alertOutcome(alert)
  const activation = alert.id !== null ? rowActivation<HTMLTableRowElement>(() => onOpenAlert(alert)) : null
  return (
    <TableRow
      aria-label={`Alert ${alert.id}, ${alert.scenario}, ${alert.value}`}
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
            <Button
              variant="link"
              title="Show only this scenario"
              className="h-auto min-w-0 shrink justify-start p-0 font-mono text-xs font-normal text-foreground"
              {...stopRowActivation}
              onClick={(event) => {
                stopRowActivation.onClick(event)
                onFilterScenario(alert.scenario)
              }}
            >
              <span className="truncate">{alert.scenario}</span>
            </Button>
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

export function AlertRunRows({ run: alertRun, onOpenAlert, onFilterScenario }: Props) {
  const [open, setOpen] = useState(false)
  const [newest] = alertRun.alerts
  const runSize = alertRun.alerts.length
  if (runSize === 1) {
    return <AlertRow alert={newest} onOpenAlert={onOpenAlert} onFilterScenario={onFilterScenario} />
  }

  return (
    <>
      <AlertRow
        alert={newest}
        onOpenAlert={onOpenAlert}
        onFilterScenario={onFilterScenario}
        scenarioLabel={runScenarioLabel(alertRun)}
        timeLead={
          <Button
            variant="ghost"
            size="icon-xs"
            className="mr-1 align-middle text-muted-foreground"
            aria-expanded={open}
            aria-label={`Show ${runSize} alerts`}
            {...stopRowActivation}
            onClick={(event) => {
              stopRowActivation.onClick(event)
              setOpen((current) => !current)
            }}
          >
            <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
          </Button>
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
            onFilterScenario={onFilterScenario}
            className="bg-muted/30 hover:bg-muted/40"
            timeClassName="pl-9"
          />
        ))}
    </>
  )
}
