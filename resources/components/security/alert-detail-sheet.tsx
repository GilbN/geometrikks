/**
 * Everything the LAPI holds for one alert: the source, the alert context
 * such as targeted paths and user agents, the decisions it produced and the
 * events the LAPI kept. The header renders from the table row while the
 * detail loads.
 */
import { Link } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"
import { DetailField, DetailSheet } from "@/components/data/detail-sheet"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import type { AlertDetailView, AlertEventView, AlertView } from "@/generated/api/types.gen"
import { crowdsecErrorMessage } from "@/lib/crowdsec"
import { alertSummary, contextLabel, eventExtras, hasHttpEvents } from "@/lib/crowdsec-alerts"
import { useCrowdsecAlert } from "@/lib/queries"
import { statusBadgeClass } from "@/lib/status-badge"
import { cn } from "@/lib/utils"

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-5 mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </h3>
  )
}

function EventRow({ event, http }: { event: AlertEventView; http: boolean }) {
  const { meta } = event
  const status = Number(meta.http_status)
  const extras = eventExtras(meta, http)
  return (
    <li className="border-b border-border/40 py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <time className="whitespace-nowrap tabular-nums text-muted-foreground">
          {new Date(event.timestamp).toLocaleTimeString()}
        </time>
        {http && Number.isFinite(status) && (
          <Badge className={cn("tabular-nums border-transparent", statusBadgeClass(status))}>{status}</Badge>
        )}
        {http && <span className="font-mono font-medium">{meta.http_verb}</span>}
        {http && <span className="min-w-0 break-all font-mono">{meta.http_path}</span>}
      </div>
      {http && (meta.target_fqdn || meta.http_user_agent) && (
        <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
          {[meta.target_fqdn, meta.http_user_agent].filter(Boolean).join(" · ")}
        </p>
      )}
      {extras.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group mt-1 inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
            {extras.length} more fields
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px]">
              {extras.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="break-all">{value}</dd>
                </div>
              ))}
            </dl>
          </CollapsibleContent>
        </Collapsible>
      )}
    </li>
  )
}

function AlertBody({ alert, onNavigate }: { alert: AlertDetailView; onNavigate: () => void }) {
  const isIp = alert.scope === "Ip"
  const http = hasHttpEvents(alert.events)
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {alert.kind && alert.kind !== "crowdsec" && (
          <Badge variant="secondary" className="uppercase">{alert.kind}</Badge>
        )}
        {alert.simulated && (
          <Badge variant="outline" title="CrowdSec ran this scenario in simulation mode and enforced nothing">
            Simulated
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{alertSummary(alert.message)}</p>

      <SectionTitle>Source</SectionTitle>
      <dl>
        <DetailField
          label={isIp ? "IP address" : alert.scope}
          value={
            <span className="inline-flex flex-wrap items-center gap-2 font-mono text-xs">
              {alert.value}
              {isIp && (
                <IpBanControls ip={alert.value}>
                  <InspectIpButton ip={alert.value} onOpen={onNavigate} />
                </IpBanControls>
              )}
            </span>
          }
        />
        <DetailField label="Country" value={alert.country} />
        <DetailField
          label="AS"
          value={alert.asName ? `${alert.asName}${alert.asNumber ? ` (AS${alert.asNumber})` : ""}` : null}
        />
        <DetailField label="Range" value={alert.range} mono />
        <DetailField label="First event" value={alert.startAt && new Date(alert.startAt).toLocaleString()} />
        <DetailField label="Last event" value={alert.stopAt && new Date(alert.stopAt).toLocaleString()} />
        <DetailField label="Reported by" value={alert.machineId} mono />
      </dl>
      {isIp && (
        <Button asChild variant="link" size="sm" className="h-auto px-0">
          <Link to="/access-logs" search={{ ip: [alert.value] }} onClick={onNavigate}>
            This IP in Access logs →
          </Link>
        </Button>
      )}

      {alert.context.length > 0 && (
        <>
          <SectionTitle>Context</SectionTitle>
          <dl>
            {alert.context.map((entry) => (
              <DetailField
                key={entry.key}
                label={contextLabel(entry.key)}
                value={
                  <ul className="flex flex-col gap-1">
                    {entry.values.map((value) => (
                      <li key={value} className="break-all font-mono text-xs">{value}</li>
                    ))}
                  </ul>
                }
              />
            ))}
          </dl>
        </>
      )}

      <SectionTitle>Decisions</SectionTitle>
      {alert.decisions.length === 0 ? (
        <p className="text-sm text-muted-foreground">This alert produced no decision.</p>
      ) : (
        <ul>
          {alert.decisions.map((decision) => (
            <li
              key={decision.id ?? `${decision.origin}:${decision.scenario}:${decision.duration}`}
              className={cn("flex flex-wrap items-center gap-2 border-b border-border/40 py-2 text-xs last:border-0", decision.expired && "opacity-60")}
            >
              <DecisionBadge
                type={decision.type}
                title={decision.expired ? `Expired CrowdSec ${decision.type} decision` : undefined}
              />
              <span className="font-mono">{decision.value}</span>
              <span className="text-muted-foreground">
                {decision.origin} · {decision.expired ? "expired" : `${decision.duration} left`}
                {decision.simulated && " · simulated"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>Events</SectionTitle>
      {alert.events.length === 0 ? (
        <p className="text-sm text-muted-foreground">The LAPI stored no events for this alert.</p>
      ) : (
        <>
          {alert.events.length < alert.eventsCount && (
            <p className="text-xs text-muted-foreground">
              Showing {alert.events.length} of {alert.eventsCount}. CrowdSec stores a sample per alert.
            </p>
          )}
          <ul>
            {alert.events.map((event, index) => (
              <EventRow key={`${event.timestamp}-${index}`} event={event} http={http} />
            ))}
          </ul>
        </>
      )}
    </>
  )
}

export function AlertDetailSheet({
  alert,
  onOpenChange,
}: {
  alert: AlertView | null
  onOpenChange: (open: boolean) => void
}) {
  const detail = useCrowdsecAlert(alert?.id ?? null)
  return (
    <DetailSheet
      open={alert !== null}
      onOpenChange={onOpenChange}
      title={<span className="break-all font-mono text-sm">{alert?.scenario ?? "Alert details"}</span>}
      description={
        alert ? `Alert #${alert.id} · ${new Date(alert.createdAt).toLocaleString()} · ${alert.eventsCount} events` : undefined
      }
    >
      {detail.isPending && (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      )}
      {detail.isError && (
        <p role="alert" className="text-sm text-destructive">
          {crowdsecErrorMessage(detail.error, "Could not load this alert.")}
        </p>
      )}
      {detail.data && <AlertBody alert={detail.data} onNavigate={() => onOpenChange(false)} />}
    </DetailSheet>
  )
}
