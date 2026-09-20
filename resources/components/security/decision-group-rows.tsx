/**
 * Table rows for one target in Active decisions. A single decision is one
 * row. Several decisions are a summary row that expands, on activation, to
 * one sub-row each. Any other row opens the alert behind its decision when
 * the decision has one.
 */
import { useState } from "react"
import { toast } from "sonner"
import { ChevronRight, Loader2, ShieldOff } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TableCell, TableRow } from "@/components/ui/table"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { rowActivation, stopRowActivation } from "@/components/data/row-activation"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import type { DecisionGroupView, GroupedDecisionView } from "@/generated/api/types.gen"
import { crowdsecErrorMessage } from "@/lib/crowdsec"
import { decisionHasAlert } from "@/lib/crowdsec-alerts"
import { useUnbanIp } from "@/lib/queries"
import { cn } from "@/lib/utils"
import type { DecisionRef } from "./alert-detail-sheet"

type Props = {
  group: DecisionGroupView
  writeEnabled: boolean
  dimmed: boolean
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

function ScenarioCell({ scenario }: { scenario: string }) {
  return (
    <TableCell className="max-w-[260px] truncate font-mono text-xs" title={scenario}>
      {scenario}
    </TableCell>
  )
}

function UnbanButton({ group }: { group: DecisionGroupView }) {
  const unban = useUnbanIp()
  const { ip, decisionCount } = group
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="text-muted-foreground"
      title={decisionCount > 1 ? `Unban ${ip}. Removes all ${decisionCount} decisions.` : `Unban ${ip}`}
      disabled={unban.isPending}
      onClick={() =>
        unban.mutate(ip, {
          onError: (err) =>
            toast.error(crowdsecErrorMessage(err, `Unban failed for ${ip}; the LAPI may be unreachable.`)),
        })
      }
    >
      {unban.isPending ? <Loader2 className="animate-spin" /> : <ShieldOff />}
    </Button>
  )
}

export function DecisionGroupRows(props: Props) {
  const { group, writeEnabled, dimmed } = props
  const [open, setOpen] = useState(false)
  const alertActivation = alertActivationFor(props)
  const multiple = group.decisionCount > 1
  const isIp = group.scope === "Ip"
  const summary = multiple
    ? {
        "aria-expanded": open,
        "aria-label": `${group.decisionCount} decisions for ${group.ip}`,
        ...rowActivation<HTMLTableRowElement>(() => setOpen((current) => !current)),
      }
    : alertActivation(group.decisions[0])

  return (
    <>
      <TableRow {...summary} className={cn(summary?.className, dimmed && "opacity-60")}>
        <TableCell className="font-mono">
          {multiple && (
            <ChevronRight
              aria-hidden
              className={cn("mr-1 inline size-3.5 align-middle text-muted-foreground transition-transform", open && "rotate-90")}
            />
          )}
          {group.ip}
          {isIp ? (
            <span {...stopRowActivation}>
              <InspectIpButton ip={group.ip} className="ml-1" />
            </span>
          ) : (
            <Badge variant="outline" className="ml-2 align-middle">{group.scope}</Badge>
          )}
        </TableCell>
        <TableCell>
          <DecisionBadge type={group.type} />
        </TableCell>
        <TableCell>{group.countryName ?? group.countryCode ?? "-"}</TableCell>
        <TableCell>{group.city ?? "-"}</TableCell>
        <TableCell>
          <span className="inline-flex flex-wrap gap-1">
            {group.origins.map((origin) => (
              <Badge key={origin} variant="secondary">{origin}</Badge>
            ))}
          </span>
        </TableCell>
        {multiple ? (
          <TableCell className="text-xs text-muted-foreground">{group.decisionCount} scenarios</TableCell>
        ) : (
          <ScenarioCell scenario={group.decisions[0].scenario} />
        )}
        <TableCell
          className="whitespace-nowrap tabular-nums"
          title={multiple ? "When the last of these decisions expires" : undefined}
        >
          {group.duration}
        </TableCell>
        <TableCell
          className={cn("text-right tabular-nums", (group.requestCount24h ?? 0) > 0 && "font-semibold text-amber-500")}
        >
          {group.requestCount24h ?? "-"}
        </TableCell>
        {writeEnabled && <TableCell {...stopRowActivation}>{isIp && <UnbanButton group={group} />}</TableCell>}
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
              <ScenarioCell scenario={decision.scenario} />
              <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{decision.duration}</TableCell>
              <TableCell colSpan={writeEnabled ? 2 : 1} />
            </TableRow>
          )
        })}
    </>
  )
}
