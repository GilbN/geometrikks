/**
 * Table rows for one target in Active decisions. A single decision is one
 * row. Several decisions are a summary row that expands, on activation, to
 * one sub-row each. Any other row opens the alert behind its decision when
 * the decision has one.
 */
import { useState } from "react"
import { Loader2, ShieldOff, Undo2 } from "lucide-react"
import { CountryLabel } from "@/components/country-flag"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TableCell, TableRow } from "@/components/ui/table"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { ScenarioLabel } from "@/components/crowdsec/scenario-label"
import { rowActivation, stopRowActivation } from "@/components/data/row-activation"
import { IpActionsMenu } from "@/components/ip-actions/ip-actions-menu"
import type { DecisionGroupView, GroupedDecisionView } from "@/generated/api/types.gen"
import { distinctScenarioCount } from "@/lib/crowdsec"
import { decisionHasAlert, formatTimeLeft, timeLeftText } from "@/lib/crowdsec-alerts"
import { undoIpAction, useIpActions, usePendingIpAction } from "@/lib/pending-ip-actions"
import { cn } from "@/lib/utils"
import type { DecisionRef } from "./alert-detail-sheet"
import { ExpandChevron, ROW_TARGET_VALUE_CLASS, RowTarget, TwoLineCell, WRAPPING_BADGE_CLASS } from "./two-line-cell"

type Props = {
  group: DecisionGroupView
  writeEnabled: boolean
  dimmed: boolean
  /** One cell per row on two lines, for a narrow card. */
  narrow?: boolean
  /** Start with the group's decisions listed, when it has more than one. */
  defaultOpen?: boolean
  onOpenAlert: (decision: DecisionRef) => void
}

/** Row props that open the decision's alert, or nothing when it has none.
 *  Alerts need machine credentials, the same gate as Alert history. */
function alertActivationFor({ group, writeEnabled, onOpenAlert }: Props) {
  return (decision: GroupedDecisionView) => {
    if (!writeEnabled || !decisionHasAlert(group.scope, decision)) return null
    const { id, scenario } = decision
    return {
      "aria-label": `Alert behind the ${scenario} decision for ${group.ip}`,
      ...rowActivation<HTMLTableRowElement>(() => onOpenAlert({ id: id!, ip: group.ip, scenario })),
    }
  }
}

function ScenarioCell({ scenario, shownOrigins }: { scenario: string; shownOrigins: readonly string[] }) {
  return (
    <TableCell className="max-w-[260px]">
      <ScenarioLabel scenario={scenario} shownOrigins={shownOrigins} className="max-w-full" />
    </TableCell>
  )
}

function UnbanButton({ group }: { group: DecisionGroupView }) {
  const { unban } = useIpActions()
  const pendingAction = usePendingIpAction(group.ip)
  const pending = pendingAction !== null
  const { ip } = group
  // While the unban waits to be sent, this button undoes it.
  if (pendingAction && !pendingAction.sending) {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground pointer-coarse:min-h-8 pointer-coarse:min-w-8"
        title={`Undo the unban of ${ip}`}
        aria-label={`Undo the unban of ${ip}`}
        onClick={() => undoIpAction(ip)}
      >
        <Undo2 />
      </Button>
    )
  }
  const title = group.scope === "Range"
    ? `Unban ${ip}. Removes every active decision on this range, from any origin.`
    : `Unban ${ip}. Removes every active decision on this IP, from any origin. A range decision covering it stays.`
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="text-muted-foreground pointer-coarse:min-h-8 pointer-coarse:min-w-8"
      title={title}
      disabled={pending}
      onClick={() => unban(ip)}
    >
      {pending ? <Loader2 className="animate-spin" /> : <ShieldOff />}
    </Button>
  )
}

/** Stands in for the decision badge while an unban waits in the undo window. */
function UnbanningBadge() {
  return (
    <Badge variant="outline" className="shrink-0 gap-1 text-muted-foreground">
      <Loader2 className="animate-spin" />
      Unbanning
    </Badge>
  )
}

export function DecisionGroupRows(props: Props) {
  const { group, writeEnabled, narrow = false, defaultOpen = false } = props
  const unbanning = usePendingIpAction(group.ip)?.action.kind === "unban"
  const dimmed = props.dimmed || unbanning
  // A one-decision group has nothing to list under it.
  const [open, setOpen] = useState(defaultOpen && group.decisionCount > 1)
  const alertActivation = alertActivationFor(props)
  const multiple = group.decisionCount > 1
  const scenarioCount = distinctScenarioCount(group.decisions)
  const isIp = group.scope === "Ip"
  // Enrichment only covers Ip decisions; a Country decision's value is the code.
  const countryCode = group.countryCode ?? (group.scope === "Country" ? group.ip : null)
  const summary = multiple
    ? {
        "aria-expanded": open,
        "aria-label": `${group.decisionCount} decisions for ${group.ip}`,
        ...rowActivation<HTMLTableRowElement>(() => setOpen((current) => !current)),
      }
    : alertActivation(group.decisions[0])

  const chevron = multiple && <ExpandChevron open={open} />
  const scenarioSummary = scenarioCount > 1 ? (
    <span className="text-xs text-muted-foreground">{scenarioCount} scenarios</span>
  ) : (
    <ScenarioLabel scenario={group.decisions[0].scenario} />
  )

  if (narrow) {
    return (
      <>
        <TableRow {...summary} className={cn(summary?.className, dimmed && "opacity-60")}>
          <TwoLineCell
            top={
              <RowTarget
                open={multiple ? open : undefined}
                countryCode={countryCode}
                countryName={group.countryName}
                value={<span className={ROW_TARGET_VALUE_CLASS}>{group.ip}</span>}
                actions={
                  isIp ? (
                    <IpActionsMenu ip={group.ip} countryCode={group.countryCode} countryName={group.countryName} city={group.city} />
                  ) : (
                    <Badge variant="outline" className="shrink-0">{group.scope}</Badge>
                  )
                }
                status={
                  <>
                    {unbanning ? <UnbanningBadge /> : <DecisionBadge type={group.type} className={WRAPPING_BADGE_CLASS} />}
                    {/* Ranges have no IP actions menu, so they keep their own unban button. */}
                    {writeEnabled && group.scope === "Range" && (
                      <span {...stopRowActivation}>
                        <UnbanButton group={group} />
                      </span>
                    )}
                  </>
                }
              />
            }
            bottom={scenarioSummary}
            bottomEnd={
              <>
                {(group.requestCount24h ?? 0) > 0 && (
                  <span className="shrink-0 font-semibold tabular-nums text-amber-500" title="Requests in this server's logs in the last 24 hours">
                    {group.requestCount24h} seen
                  </span>
                )}
                <span
                  className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground"
                  title={multiple ? "When the last of these decisions expires" : undefined}
                >
                  {timeLeftText(group.duration)}
                </span>
              </>
            }
          />
        </TableRow>
        {open &&
          group.decisions.map((decision, index) => {
            const activation = alertActivation(decision)
            return (
              <TableRow
                key={decision.id ?? index}
                {...activation}
                className={cn("bg-muted/30 hover:bg-muted/40", activation?.className, dimmed && "opacity-60")}
              >
                <TwoLineCell
                  nested
                  top={
                    <>
                      <DecisionBadge type={decision.type} className={cn(WRAPPING_BADGE_CLASS, "max-w-[60%]")} />
                      <ScenarioLabel scenario={decision.scenario} shownOrigins={[decision.origin]} className="flex-1" />
                    </>
                  }
                  bottom={<span className="truncate text-muted-foreground">{decision.origin}</span>}
                  bottomEnd={
                    <span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">{timeLeftText(decision.duration)}</span>
                  }
                />
              </TableRow>
            )
          })}
      </>
    )
  }

  return (
    <>
      <TableRow {...summary} className={cn(summary?.className, dimmed && "opacity-60")}>
        <TableCell className="font-mono">
          {chevron}
          {group.ip}
          {isIp ? (
            <IpActionsMenu ip={group.ip} countryCode={group.countryCode} countryName={group.countryName} city={group.city} />
          ) : (
            <Badge variant="outline" className="ml-2 align-middle">{group.scope}</Badge>
          )}
        </TableCell>
        <TableCell>
          {unbanning ? <UnbanningBadge /> : <DecisionBadge type={group.type} />}
        </TableCell>
        <TableCell>
          {countryCode ? <CountryLabel code={countryCode} name={group.countryName} /> : "-"}
        </TableCell>
        <TableCell>{group.city ?? "-"}</TableCell>
        <TableCell>
          <span className="inline-flex flex-wrap gap-1">
            {group.origins.map((origin) => (
              <Badge key={origin} variant="secondary">{origin}</Badge>
            ))}
          </span>
        </TableCell>
        {scenarioCount > 1 ? (
          <TableCell className="text-xs text-muted-foreground">{scenarioCount} scenarios</TableCell>
        ) : (
          <ScenarioCell scenario={group.decisions[0].scenario} shownOrigins={group.origins} />
        )}
        <TableCell
          className="whitespace-nowrap tabular-nums"
          title={multiple ? "When the last of these decisions expires" : undefined}
        >
          {formatTimeLeft(group.duration)}
        </TableCell>
        <TableCell
          className={cn("text-right tabular-nums", (group.requestCount24h ?? 0) > 0 && "font-semibold text-amber-500")}
        >
          {group.requestCount24h ?? "-"}
        </TableCell>
        {writeEnabled && <TableCell {...stopRowActivation}>{(isIp || group.scope === "Range") && <UnbanButton group={group} />}</TableCell>}
      </TableRow>
      {open &&
        group.decisions.map((decision, index) => {
          const activation = alertActivation(decision)
          return (
            <TableRow
              key={decision.id ?? index}
              {...activation}
              className={cn("bg-muted/30 hover:bg-muted/40", activation?.className, dimmed && "opacity-60")}
            >
              <TableCell />
              <TableCell>
                <DecisionBadge type={decision.type} />
              </TableCell>
              <TableCell colSpan={2} />
              <TableCell>
                <Badge variant="secondary">{decision.origin}</Badge>
              </TableCell>
              <ScenarioCell scenario={decision.scenario} shownOrigins={[decision.origin]} />
              <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{formatTimeLeft(decision.duration)}</TableCell>
              <TableCell colSpan={writeEnabled ? 2 : 1} />
            </TableRow>
          )
        })}
    </>
  )
}
