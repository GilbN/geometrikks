/**
 * Everything the LAPI holds for one alert: the source, the alert context
 * such as targeted paths and user agents, the decisions it produced and the
 * events the LAPI kept. The header renders from the table row while the
 * detail loads.
 */
import { useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Check, ChevronRight, Copy } from "lucide-react"
import { CountryLabel } from "@/components/country-flag"
import { DetailField, DetailSheet } from "@/components/data/detail-sheet"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { AlertKindBadge } from "@/components/security/alert-kind-badge"
import { IpBanControls } from "@/components/crowdsec/ip-ban-controls"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import { FlyToIpButton } from "@/components/map/FlyToIpButton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import type { AlertDetailView, AlertEventView, AlertView } from "@/generated/api/types.gen"
import { copyText } from "@/lib/clipboard"
import { crowdsecErrorMessage } from "@/lib/crowdsec"
import {
  CHALLENGE_EVENT_KEYS,
  HTTP_EVENT_KEYS,
  alertDescription,
  alertSummary,
  asLabel,
  challengeContext,
  contextLabel,
  eventExtras,
  hasHttpEvents,
  isChallengeEvent,
  shortFingerprint,
  signalNote,
  type ChallengeContext,
} from "@/lib/crowdsec-alerts"
import type { UseQueryResult } from "@tanstack/react-query"
import { useCrowdsecAlert, useCrowdsecDecisionAlert } from "@/lib/queries"
import { statusBadgeClass } from "@/lib/status-badge"
import { cn } from "@/lib/utils"

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-5 mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </h3>
  )
}

// The challenge's own outcome words, colored like the decision badges:
// rejected is the verdict, failed is a broken submission.
function challengeEventClass(event: string | undefined): string {
  if (event === "rejected") return "bg-destructive/10 text-destructive"
  if (event === "failed") return "bg-amber-500/10 text-amber-500 dark:bg-amber-500/20"
  return ""
}

function EventRow({ event, http }: { event: AlertEventView; http: boolean }) {
  const { meta } = event
  const status = Number(meta.http_status)
  const challenge = isChallengeEvent(meta)
  const extras = eventExtras(meta, challenge ? CHALLENGE_EVENT_KEYS : http ? HTTP_EVENT_KEYS : [])
  const showHttp = http && !challenge
  return (
    <li className="border-b border-border/40 py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <time className="whitespace-nowrap tabular-nums text-muted-foreground">
          {new Date(event.timestamp).toLocaleTimeString()}
        </time>
        {showHttp && Number.isFinite(status) && (
          <Badge className={cn("tabular-nums border-transparent", statusBadgeClass(status))}>{status}</Badge>
        )}
        {challenge && meta.challenge_event && (
          <Badge variant="secondary" className={cn("border-transparent", challengeEventClass(meta.challenge_event))}>
            Challenge {meta.challenge_event}
          </Badge>
        )}
        {(showHttp || challenge) && <span className="font-mono font-medium">{challenge ? meta.method : meta.http_verb}</span>}
        {(showHttp || challenge) && (
          <span className="min-w-0 break-all font-mono">{challenge ? meta.target_uri : meta.http_path}</span>
        )}
      </div>
      {showHttp && (meta.target_fqdn || meta.http_user_agent) && (
        <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
          {[meta.target_fqdn, meta.http_user_agent].filter(Boolean).join(" · ")}
        </p>
      )}
      {challenge && (meta.target_host || meta.challenge_fail_reason || meta.http_user_agent) && (
        <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
          {[meta.target_host, meta.challenge_fail_reason, meta.http_user_agent].filter(Boolean).join(" · ")}
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

function CopyFingerprint({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  async function copy() {
    // The fallback textarea has to live inside the sheet, or its focus trap
    // steals the selection before the copy runs.
    const ok = await copyText(id, { container: anchor.current })
    setCopied(ok)
    if (ok) setTimeout(() => setCopied(false), 1500)
  }
  return (
    <span ref={anchor} className="inline-flex items-center gap-1 font-mono text-xs">
      <span title={id}>{shortFingerprint(id)}</span>
      <Button variant="ghost" size="icon" className="size-6" onClick={copy} aria-label="Copy the full fingerprint id">
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
    </span>
  )
}

/** What the browser challenge saw. Every field is optional: the hub's
 *  context file decides which keys the LAPI stores. */
function ChallengeSection({ challenge }: { challenge: ChallengeContext }) {
  const outcome = challenge.event ? challenge.event[0].toUpperCase() + challenge.event.slice(1) : null
  const scoreShown = challenge.score !== null
  return (
    <>
      <SectionTitle>Challenge</SectionTitle>
      <dl>
        <DetailField
          label="Outcome"
          value={
            outcome && (
              <Badge variant="secondary" className={cn("border-transparent", challengeEventClass(challenge.event ?? undefined))}>
                {outcome}
              </Badge>
            )
          }
        />
        {scoreShown ? (
          <DetailField
            label="Score"
            value={
              <div className="space-y-1">
                <span className="tabular-nums">{challenge.score}</span>
                <p className="text-xs text-muted-foreground">The signals the fingerprint scanner saw, added up.</p>
                {challenge.reasons.length > 0 && (
                  <ul className="space-y-1">
                    {challenge.reasons.map((reason) => (
                      <li key={reason.signal} className="text-xs">
                        <span className="font-mono">{reason.signal}</span>
                        {reason.points !== null && (
                          <span className="tabular-nums text-muted-foreground"> · {reason.points} points</span>
                        )}
                        {signalNote(reason.signal) && (
                          <p className="text-muted-foreground">{signalNote(reason.signal)}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            }
          />
        ) : (
          <DetailField label="Reason" value={challenge.failReason} />
        )}
        <DetailField label="Fingerprint" value={challenge.fingerprintId && <CopyFingerprint id={challenge.fingerprintId} />} />
        <DetailField label="Operating system" value={challenge.operatingSystem} />
        <DetailField label="User agent" value={challenge.userAgent} mono />
        <DetailField label="Target path" value={challenge.targetUri} mono />
      </dl>
    </>
  )
}

function AlertBody({ alert, onNavigate }: { alert: AlertDetailView; onNavigate: () => void }) {
  const isIp = alert.scope === "Ip"
  const http = hasHttpEvents(alert.events)
  const { challenge, rest: context } = challengeContext(alert.context)
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <AlertKindBadge kind={alert.kind} />
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
                  <FlyToIpButton ip={alert.value} onOpen={onNavigate} />
                </IpBanControls>
              )}
            </span>
          }
        />
        <DetailField
          label="Country"
          value={
            (alert.countryCode || alert.countryName) && (
              <CountryLabel code={alert.countryCode} name={alert.countryName} />
            )
          }
        />
        <DetailField
          label="AS"
          value={asLabel(alert.asName, alert.asNumber)}
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

      {challenge && <ChallengeSection challenge={challenge} />}

      {context.length > 0 && (
        <>
          <SectionTitle>Context</SectionTitle>
          <dl>
            {context.map((entry) => (
              <DetailField
                key={entry.key}
                label={contextLabel(entry.key)}
                value={entry.values.length === 0 ? null : (
                  <ul className="flex flex-col gap-1">
                    {entry.values.map((value) => (
                      <li key={value} className="break-all font-mono text-xs">{value}</li>
                    ))}
                  </ul>
                )}
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

function AlertSheet({
  open,
  onOpenChange,
  scenario,
  description,
  detail,
  errorFallback,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scenario: string | undefined
  description: string | undefined
  detail: UseQueryResult<AlertDetailView>
  errorFallback: string
}) {
  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={<span className="break-all font-mono text-sm">{scenario ?? "Alert details"}</span>}
      description={description}
    >
      {open && detail.isPending && (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      )}
      {detail.isError && (
        <p role="alert" className="text-sm text-destructive">
          {crowdsecErrorMessage(detail.error, errorFallback)}
        </p>
      )}
      {detail.data && <AlertBody alert={detail.data} onNavigate={() => onOpenChange(false)} />}
    </DetailSheet>
  )
}

/** Opened from an Alert history row. */
export function AlertDetailSheet({
  alert,
  onOpenChange,
}: {
  alert: AlertView | null
  onOpenChange: (open: boolean) => void
}) {
  const detail = useCrowdsecAlert(alert?.id ?? null)
  return (
    <AlertSheet
      open={alert !== null}
      onOpenChange={onOpenChange}
      scenario={alert?.scenario}
      description={alert ? alertDescription(alert) : undefined}
      detail={detail}
      errorFallback="Could not load this alert."
    />
  )
}

export type DecisionRef = { id: number; ip: string; scenario: string }

/** Opened from an Active decisions row. Shows the alert that produced the decision. */
export function DecisionAlertSheet({
  decision,
  onOpenChange,
}: {
  decision: DecisionRef | null
  onOpenChange: (open: boolean) => void
}) {
  const detail = useCrowdsecDecisionAlert(decision)
  return (
    <AlertSheet
      open={decision !== null}
      onOpenChange={onOpenChange}
      scenario={detail.data?.scenario ?? decision?.scenario}
      description={detail.data ? alertDescription(detail.data) : undefined}
      detail={detail}
      errorFallback="Could not load the alert behind this decision."
    />
  )
}
