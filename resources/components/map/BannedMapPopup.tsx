/**
 * Popup for the Banned IPs layer. One IP opens its details directly; a
 * location shared by several IPs lists them all, paged, and drills into one.
 * Decisions load only for the IP being looked at. A decision's scenario opens
 * its alert through `onOpenAlert` when it has one.
 */
import { useEffect, useRef, useState } from "react"
import type { Popup as MapLibrePopup } from "maplibre-gl"
import { Popup } from "react-map-gl/maplibre"
import { Activity, ChevronLeft, ChevronRight, ExternalLink, Globe, Loader2, MapPin, Network, ShieldBan } from "lucide-react"
import { useAbuseIpdbBlacklisted, useCrowdsecStatus, useDropNetwork, useIpDecisions } from "@/lib/queries"
import { formatNumber } from "@/lib/api"
import { crowdsecCtiUrl, crowdsecErrorMessage, winningDecision } from "@/lib/crowdsec"
import { decisionHasAlert, isBlocklistOrigin } from "@/lib/crowdsec-alerts"
import type { BannedMapIp, DecisionView } from "@/generated/api/types.gen"
import { IpBanControls } from "./IpBanControls"
import { CountryFlag, CountryLabel } from "@/components/country-flag"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import { AbuseIpdbBlacklistPopupRow } from "./AbuseIpdbBlacklistPopupRow"
import { DropPopupRow } from "./DropPopupRow"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { ExternalLinkButton } from "@/components/crowdsec/external-link"
import type { DecisionRef } from "@/components/security/alert-detail-sheet"
import { AbuseIpdbBlacklistBadge } from "@/components/abuseipdb/abuseipdb-blacklist-badge"
import { DropBadge } from "@/components/drop/drop-badge"
import { DetailField } from "@/components/data/detail-sheet"
import { Button } from "@/components/ui/button"
import { POPUP_OFFSET, POPUP_LINK_BUTTON_STYLE, POPUP_ROW_ICON_STYLE, PopupBadge, PopupCard, PopupRow } from "./PopupCard"
import { timeLeftText } from "@/lib/crowdsec-alerts"
import { scenarioText } from "@/lib/scenario-name"
import { IpLabel } from "@/components/ip-actions/ip-label"
import { CopyIpButton } from "@/components/ip-actions/ip-actions-menu"
import { MapDetailPanel, PanelBackButton, PanelInspectButton, PanelIp, PanelSection } from "./MapDetailPanel"
import { PanelBanButton } from "./PanelBanButton"
import { countryLabel } from "@/lib/ip-filter-targets"

const PAGE_SIZE = 20

/** Why a scenario is plain text instead of a button that opens its alert. */
function noAlertReason(decision: DecisionView, writeEnabled: boolean): string {
  if (isBlocklistOrigin(decision.origin)) {
    return "CrowdSec pulls blocklist decisions in bulk, so this one has no alert of its own to open."
  }
  if (!writeEnabled) return "Opening the alert behind a decision needs CrowdSec machine credentials."
  return "CrowdSec has no alert for this decision."
}

/** With `onOpen` the scenario is a button that opens the decision's alert.
 *  Without it, `note` says why not. */
function DecisionLine({ decision, onOpen, note }: { decision: DecisionView; onOpen?: () => void; note?: string }) {
  const scenario = decision.scenario ? scenarioText(decision.scenario) : "No scenario given"
  const scenarioStyle = { fontWeight: 500, overflowWrap: "anywhere" } as const
  return (
    <div style={{ fontSize: "11px", marginBottom: "4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <DecisionBadge type={decision.type} variant="popup" />
        {onOpen ? (
          <button
            className="text-primary underline decoration-primary/40 decoration-dotted underline-offset-2 hover:decoration-primary hover:decoration-solid"
            title="Open the alert behind this decision"
            onClick={onOpen}
            style={{ font: "inherit", ...scenarioStyle, background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
          >
            {scenario}
          </button>
        ) : (
          <span title={note} style={scenarioStyle}>{scenario}</span>
        )}
      </div>
      <div style={{ fontSize: "10px", color: "var(--popup-muted)" }}>{decision.origin} · {timeLeftText(decision.duration)}</div>
    </div>
  )
}

/** The IP's decisions, and whether their alerts can be opened. */
function useIpDecisionState(ip: string) {
  const decisions = useIpDecisions(ip)
  // Alerts need machine credentials, the same gate as Active decisions.
  const writeEnabled = useCrowdsecStatus().data?.writeEnabled === true
  const active = decisions.data?.filter((d) => d.scope === "Ip") ?? []
  return { decisions, writeEnabled, active }
}

function decisionKey(decision: DecisionView): string | number {
  return decision.id ?? `${decision.origin}:${decision.scenario}:${decision.duration}`
}

function decisionsHeading(isPending: boolean, count: number): string {
  return isPending ? "Loading decisions..." : count === 1 ? "Active decision" : `${count} active decisions`
}

/** A page of the IP list. A refetch can shrink the list under an open pager;
 *  the page clamps rather than render an empty page with no way back. */
function pageOf(ips: BannedMapIp[], requestedPage: number) {
  const pageCount = Math.ceil(ips.length / PAGE_SIZE)
  const page = Math.min(requestedPage, pageCount - 1)
  const start = page * PAGE_SIZE
  return { page, pageCount, start, rows: ips.slice(start, start + PAGE_SIZE) }
}

function IpDetails({
  member,
  onBack,
  onOpenAlert,
}: {
  member: BannedMapIp
  onBack?: () => void
  onOpenAlert: (decision: DecisionRef) => void
}) {
  const { decisions, writeEnabled, active } = useIpDecisionState(member.ip)

  return (
    <>
      {onBack && (
        <button style={{ ...POPUP_LINK_BUTTON_STYLE, marginBottom: "6px", marginLeft: "-4px" }} onClick={onBack}>
          <ChevronLeft style={{ width: 10, height: 10 }} />
          All IPs here
        </button>
      )}
      <PopupRow
        label="IP"
        icon={<Network style={POPUP_ROW_ICON_STYLE} />}
        value={
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <IpLabel ip={member.ip} className="text-[11px] [overflow-wrap:anywhere]" />
            <IpBanControls
              ip={member.ip}
              initialDecision={decisions.data === undefined ? "ban" : winningDecision(active)?.type ?? null}
              showBadge={false}
            >
              <InspectIpButton ip={member.ip} fromLocationId={member.locationId} />
              <ExternalLinkButton href={crowdsecCtiUrl(member.ip)} label="Look up in CrowdSec CTI" />
            </IpBanControls>
          </span>
        }
      />
      <DropPopupRow ip={member.ip} />
      <AbuseIpdbBlacklistPopupRow ip={member.ip} />
      <PopupRow label="Events" icon={<Activity style={POPUP_ROW_ICON_STYLE} />} value={<PopupBadge>{formatNumber(member.eventCount)}</PopupBadge>} />
      <PopupRow label="Location" icon={<MapPin style={POPUP_ROW_ICON_STYLE} />} value={member.city ?? "Unknown"} />
      {member.countryCode && (
        <PopupRow
          label="Country"
          icon={<Globe style={POPUP_ROW_ICON_STYLE} />}
          value={<CountryLabel code={member.countryCode}>{countryLabel(member.countryCode)}</CountryLabel>}
        />
      )}

      <div style={{ paddingTop: "8px", marginTop: "8px", borderTop: "1px solid var(--popup-border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "6px", fontSize: "12px", color: "var(--popup-muted)" }}>
          <ShieldBan style={{ width: 12, height: 12 }} />
          <span>{decisionsHeading(decisions.isPending, active.length)}</span>
          {decisions.isPending && <Loader2 style={{ width: 10, height: 10, animation: "spin 1s linear infinite" }} />}
        </div>
        {decisions.isError && (
          <div role="alert" style={{ fontSize: "11px", color: "var(--destructive)", marginBottom: "4px" }}>
            {crowdsecErrorMessage(decisions.error, "Could not load ban details.")}
            {decisions.data && " Showing the last result."}
            <button style={{ ...POPUP_LINK_BUTTON_STYLE, marginLeft: "4px" }} onClick={() => void decisions.refetch()}>Retry</button>
          </div>
        )}
        {decisions.isSuccess && active.length === 0 && (
          <p role="status" style={{ fontSize: "11px", color: "var(--popup-muted)", margin: 0 }}>No active decision remains for this IP.</p>
        )}
        {active.map((decision) => {
          const key = decisionKey(decision)
          return writeEnabled && decisionHasAlert(decision.scope, decision) ? (
            <DecisionLine
              key={key}
              decision={decision}
              onOpen={() => onOpenAlert({ id: decision.id!, ip: member.ip, scenario: decision.scenario })}
            />
          ) : (
            <DecisionLine key={key} decision={decision} note={noAlertReason(decision, writeEnabled)} />
          )
        })}
      </div>
    </>
  )
}

function IpList({ ips, page: requestedPage, onPageChange: setPage, onSelect }: {
  ips: BannedMapIp[]
  page: number
  onPageChange: (page: number) => void
  onSelect: (ip: BannedMapIp) => void
}) {
  const { page, pageCount, start, rows } = pageOf(ips, requestedPage)

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        {rows.map((ip) => (
          <button
            key={ip.ip}
            className="hover:bg-foreground/[0.07]"
            onClick={() => onSelect(ip)}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "8px",
              width: "100%",
              border: "none",
              borderRadius: "4px",
              padding: "3px 4px",
              margin: "0 -4px",
              cursor: "pointer",
              color: "inherit",
              textAlign: "left",
            }}
          >
            <IpLabel ip={ip.ip} className="text-[11px]" />
            <span style={{ fontSize: "10px", color: "var(--popup-muted)", flexShrink: 0 }}>
              <span style={{ fontWeight: 500, color: "var(--popup-fg)" }}>{formatNumber(ip.eventCount)}</span>
              {(ip.city ?? ip.countryCode) && (
                <>
                  {" · "}
                  <CountryFlag code={ip.countryCode} className="mr-1 inline-block h-[9px] w-3 align-[-1px]" />
                  {ip.city ?? ip.countryCode}
                </>
              )}
            </span>
          </button>
        ))}
      </div>
      {pageCount > 1 && (
        <nav
          aria-label="Banned IP pages"
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "6px", paddingTop: "6px", borderTop: "1px solid var(--popup-border)", fontSize: "10px", color: "var(--popup-muted)" }}
        >
          <button style={{ ...POPUP_LINK_BUTTON_STYLE, opacity: page === 0 ? 0.4 : 1 }} disabled={page === 0} onClick={() => setPage(page - 1)}>
            <ChevronLeft style={{ width: 10, height: 10 }} />
            Prev
          </button>
          <span>{start + 1}-{start + rows.length} of {ips.length}</span>
          <button style={{ ...POPUP_LINK_BUTTON_STYLE, opacity: page + 1 >= pageCount ? 0.4 : 1 }} disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>
            Next
            <ChevronRight style={{ width: 10, height: 10 }} />
          </button>
        </nav>
      )}
    </>
  )
}

function bannedTitle(selected: BannedMapIp | null, ips: BannedMapIp[]): string {
  return selected ? "Banned IP" : `${ips.length.toLocaleString()} banned IP${ips.length === 1 ? "" : "s"}`
}

const BANNED_FOOTNOTE = "Current CrowdSec decisions seen in the selected traffic range."

export function BannedMapPopup({
  longitude,
  latitude,
  ips,
  onClose,
  onOpenAlert,
}: {
  longitude: number
  latitude: number
  ips: BannedMapIp[]
  onClose: () => void
  onOpenAlert: (decision: DecisionRef) => void
}) {
  // Only the address is state; the member resolves against the current list
  // so a refetch updates its count, and one that removes the IP falls back
  // to the list instead of showing details for an IP no longer mapped.
  const [selectedIp, setSelectedIp] = useState<string | null>(ips.length === 1 ? ips[0].ip : null)
  // Here so Back returns to the page the IP was picked from.
  const [page, setPage] = useState(0)
  const selected = selectedIp === null ? null : ips.find((ip) => ip.ip === selectedIp) ?? null
  const hasIpv6 = ips.some((ip) => ip.ip.includes(":"))
  const title = bannedTitle(selected, ips)

  const popupRef = useRef<MapLibrePopup>(null)
  return (
    <Popup
      ref={popupRef}
      longitude={longitude}
      latitude={latitude}
      offset={POPUP_OFFSET}
      onClose={onClose}
      closeButton={false}
      closeOnClick={false}
      className="geo-popup"
      maxWidth={hasIpv6 ? "380px" : "300px"}
      style={{ background: "transparent" }}
    >
      {/* The accessible name stays fixed while the visible header changes;
          tests/browser/banned-map.pw.ts locates this popup by that name. */}
      <div role="dialog" aria-label="Banned IPs">
        <PopupCard
          onClose={onClose}
          point={[longitude, latitude]}
          popupRef={popupRef}
          closeLabel="Close banned IP popup"
          header={
            <>
              <ShieldBan style={{ width: 16, height: 16, color: "var(--destructive)", flexShrink: 0 }} />
              <span style={{ fontSize: "14px", fontWeight: 600 }}>{title}</span>
            </>
          }
        >
          <div>
            {selected
              ? (
                <IpDetails
                  member={selected}
                  onBack={ips.length > 1 ? () => setSelectedIp(null) : undefined}
                  onOpenAlert={onOpenAlert}
                />
              )
              : <IpList ips={ips} page={page} onPageChange={setPage} onSelect={(ip) => setSelectedIp(ip.ip)} />}
          </div>
          <div style={{ paddingTop: "6px", marginTop: "6px", borderTop: "1px solid var(--popup-border)", fontSize: "10px", color: "var(--popup-muted)" }}>
            {BANNED_FOOTNOTE}
          </div>
        </PopupCard>
      </div>
    </Popup>
  )
}

function PanelDecisionLine({ decision, onOpen, note }: { decision: DecisionView; onOpen?: () => void; note?: string }) {
  const scenario = decision.scenario ? scenarioText(decision.scenario) : "No scenario given"
  return (
    <li className="border-b border-border/60 py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <DecisionBadge type={decision.type} />
        {onOpen ? (
          <Button
            variant="link"
            className="h-auto min-h-11 whitespace-normal p-0 text-left font-medium [overflow-wrap:anywhere] underline decoration-primary/40 decoration-dotted"
            title="Open the alert behind this decision"
            onClick={onOpen}
          >
            {scenario}
          </Button>
        ) : (
          <span title={note} className="font-medium [overflow-wrap:anywhere]">{scenario}</span>
        )}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{decision.origin} · {timeLeftText(decision.duration)}</div>
    </li>
  )
}

function PanelIpDetails({ member, onOpenAlert }: { member: BannedMapIp; onOpenAlert: (decision: DecisionRef) => void }) {
  const { decisions, writeEnabled, active } = useIpDecisionState(member.ip)
  const dropNetwork = useDropNetwork(member.ip)
  const blacklisted = useAbuseIpdbBlacklisted(member.ip)
  return (
    <>
      <PanelIp ip={member.ip}>
        {dropNetwork && <DropBadge variant="long" sblId={dropNetwork.sblId} linked />}
        {blacklisted && <AbuseIpdbBlacklistBadge />}
        <CopyIpButton ip={member.ip} className="ml-auto size-11 [&_svg:not([class*='size-'])]:size-5" />
      </PanelIp>
      <dl>
        <DetailField label="Events" value={formatNumber(member.eventCount)} />
        <DetailField label="Location" value={member.city ?? "Unknown"} />
        {member.countryCode && <DetailField label="Country" value={<CountryLabel code={member.countryCode}>{countryLabel(member.countryCode)}</CountryLabel>} />}
      </dl>
      <PanelSection
        icon={decisions.isPending ? <Loader2 className="animate-spin" /> : <ShieldBan />}
        title={decisionsHeading(decisions.isPending, active.length)}
      >
        {decisions.isError && (
          <div role="alert" className="flex flex-wrap items-center gap-x-2 text-destructive">
            {crowdsecErrorMessage(decisions.error, "Could not load ban details.")}
            {decisions.data && " Showing the last result."}
            <Button variant="ghost" className="h-11" onClick={() => void decisions.refetch()}>Retry</Button>
          </div>
        )}
        {decisions.isSuccess && active.length === 0 && (
          <p role="status" className="text-muted-foreground">No active decision remains for this IP.</p>
        )}
        <ul>
          {active.map((decision) =>
            writeEnabled && decisionHasAlert(decision.scope, decision) ? (
              <PanelDecisionLine
                key={decisionKey(decision)}
                decision={decision}
                onOpen={() => onOpenAlert({ id: decision.id!, ip: member.ip, scenario: decision.scenario })}
              />
            ) : (
              <PanelDecisionLine key={decisionKey(decision)} decision={decision} note={noAlertReason(decision, writeEnabled)} />
            ),
          )}
        </ul>
      </PanelSection>
    </>
  )
}

function PanelIpFooter({ member }: { member: BannedMapIp }) {
  const { decisions, active } = useIpDecisionState(member.ip)
  return (
    <>
      <PanelInspectButton ip={member.ip} fromLocationId={member.locationId} />
      <Button asChild variant="outline" className="h-11 flex-1">
        <a href={crowdsecCtiUrl(member.ip)} target="_blank" rel="noopener noreferrer" aria-label="Look up in CrowdSec CTI">
          <ExternalLink className="size-5" />
          CTI
        </a>
      </Button>
      <PanelBanButton
        ip={member.ip}
        initialDecision={decisions.data === undefined ? "ban" : winningDecision(active)?.type ?? null}
        footer
      />
    </>
  )
}

function PanelIpList({ ips, page: requestedPage, onPageChange, onSelect }: {
  ips: BannedMapIp[]
  page: number
  onPageChange: (page: number) => void
  onSelect: (ip: BannedMapIp) => void
}) {
  const { page, pageCount, start, rows } = pageOf(ips, requestedPage)
  return (
    <>
      <ul>
        {rows.map((ip) => (
          <li key={ip.ip} className="border-b border-border/60 last:border-0">
            <button
              data-ip={ip.ip}
              onClick={() => onSelect(ip)}
              className="-mx-2 flex min-h-13 w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 text-left hover:bg-muted"
            >
              <span className="min-w-0 flex-1">
                <IpLabel ip={ip.ip} className="text-[15px] break-all" />
                {(ip.city ?? ip.countryCode) && (
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CountryFlag code={ip.countryCode} className="h-[9px] w-3" />
                    {ip.city ?? ip.countryCode}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{formatNumber(ip.eventCount)}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
      {pageCount > 1 && (
        <nav aria-label="Banned IP pages" className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
          <Button variant="outline" className="h-11" disabled={page === 0} onClick={() => onPageChange(page - 1)}>
            <ChevronLeft />
            Prev
          </Button>
          <span className="tabular-nums">{start + 1}-{start + rows.length} of {ips.length}</span>
          <Button variant="outline" className="h-11" disabled={page + 1 >= pageCount} onClick={() => onPageChange(page + 1)}>
            Next
            <ChevronRight />
          </Button>
        </nav>
      )}
    </>
  )
}

/** The banned popup's content on a phone, in a MapDetailPanel. */
export function BannedMapPanel({
  longitude,
  latitude,
  ips,
  onClose,
  onOpenAlert,
}: {
  longitude: number
  latitude: number
  ips: BannedMapIp[]
  onClose: () => void
  onOpenAlert: (decision: DecisionRef) => void
}) {
  // Same selection model as BannedMapPopup. The page lives here so Back
  // returns to the page the IP was picked from.
  const [selectedIp, setSelectedIp] = useState<string | null>(ips.length === 1 ? ips[0].ip : null)
  const [page, setPage] = useState(0)
  const selected = selectedIp === null ? null : ips.find((ip) => ip.ip === selectedIp) ?? null
  // Opening an IP or going Back unmounts the focused button. Opening moves
  // focus to Back, and Back returns it to the row the IP was opened from.
  const bodyRef = useRef<HTMLDivElement>(null)
  const navigated = useRef(false)
  const openedFrom = useRef<string | null>(null)
  const navigate = (ip: string | null) => {
    navigated.current = true
    if (ip !== null) openedFrom.current = ip
    setSelectedIp(ip)
  }
  useEffect(() => {
    if (!navigated.current) return
    navigated.current = false
    const body = bodyRef.current
    const panel = body?.closest<HTMLElement>('[role="dialog"]')
    if (selectedIp !== null) {
      panel?.querySelector<HTMLElement>('[data-slot="panel-back"]')?.focus({ preventScroll: true })
      return
    }
    // Focus elsewhere on the page stays put when a refetch drops the open IP.
    const active = document.activeElement
    if (active !== null && active !== document.body && !panel?.contains(active)) return
    // The row is gone when a refetch or an unban dropped its IP.
    const row = openedFrom.current === null
      ? null
      : body?.querySelector<HTMLElement>(`[data-ip="${CSS.escape(openedFrom.current)}"]`)
    ;(row ?? panel)?.focus({ preventScroll: !row })
  }, [selectedIp])
  // An unban or a refetch can drop the open IP. The list shows instead, and
  // focus moves the same way Back moves it.
  const selectionLost = selectedIp !== null && selected === null
  useEffect(() => {
    if (!selectionLost) return
    navigated.current = true
    setSelectedIp(null)
  }, [selectionLost])
  const place = selected
    ? [selected.city, selected.countryCode && countryLabel(selected.countryCode)].filter(Boolean).join(", ")
    : null

  return (
    <MapDetailPanel
      label="Banned IPs"
      point={[longitude, latitude]}
      onClose={onClose}
      closeLabel="Close banned IP details"
      leading={selected && ips.length > 1 && (
        <PanelBackButton label="All IPs here" onClick={() => navigate(null)}>
          <ChevronLeft className="size-5" />
        </PanelBackButton>
      )}
      icon={<ShieldBan className="size-5 text-destructive" />}
      title={bannedTitle(selected, ips)}
      subtitle={selected ? (place || "Location unknown") : undefined}
      footer={selected && <PanelIpFooter member={selected} />}
    >
      <div ref={bodyRef}>
        {selected
          ? <PanelIpDetails member={selected} onOpenAlert={onOpenAlert} />
          : <PanelIpList ips={ips} page={page} onPageChange={setPage} onSelect={(ip) => navigate(ip.ip)} />}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{BANNED_FOOTNOTE}</p>
    </MapDetailPanel>
  )
}
