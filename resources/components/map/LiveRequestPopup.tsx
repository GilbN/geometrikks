/**
 * Detail for one live request. Styled with inline CSS variables like MapPopup,
 * since MapLibre popups render outside the Tailwind-scoped tree.
 *
 * A request whose log line had no GeoIP match has no coordinates, so there is
 * nowhere on the map to anchor a MapLibre `Popup`. `LiveRequestCard` renders
 * the same detail as a small dismissible card centered over the map instead,
 * so the request stays reachable regardless of which entry point (strip or
 * sheet) opened it.
 */
import { useRef, type RefObject } from "react"
import type { Popup as MapLibrePopup } from "maplibre-gl"
import { Popup } from "react-map-gl/maplibre"
import { formatBytes } from "@/lib/api"
import { PACKET_COLORS } from "@/lib/live-traffic/classify"
import { formatDurationOrNa } from "@/lib/timing"
import { IpBanControls } from "./IpBanControls"
import { CountryLabel } from "@/components/country-flag"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import { AbuseIpdbBlacklistPopupRow } from "./AbuseIpdbBlacklistPopupRow"
import { DropPopupRow } from "./DropPopupRow"
import { POPUP_OFFSET, POPUP_ROW_ICON_STYLE, PopupCard, PopupRow as Row } from "./PopupCard"
import { ArrowDownToLine, Building2, Globe, Link2, MapPin, MapPinOff, MonitorSmartphone, Network, Server, Timer } from "lucide-react"
import { MapDetailPanel, PanelInspectButton } from "./MapDetailPanel"
import { IpStatusDetails } from "./IpStatusDetails"
import { IpLabel } from "@/components/ip-actions/ip-label"
import { CopyIpButton } from "@/components/ip-actions/ip-actions-menu"
import type { DecisionRef } from "@/components/security/alert-detail-sheet"
import { PanelBanButton } from "./PanelBanButton"
import { countryLabel } from "@/lib/ip-filter-targets"
import { DetailField } from "@/components/data/detail-sheet"
import { DropBadge } from "@/components/drop/drop-badge"
import { resolveDecision } from "@/lib/crowdsec"
import { useBannedIps, useDropNetwork } from "@/lib/queries"
import type { LiveRequest } from "@/lib/live-traffic/types"

function asnText(log: LiveRequest["log"]): string | null {
  if (!log || log.autonomous_system_number == null) return null
  return `AS${log.autonomous_system_number}${log.autonomous_system_organization ? ` ${log.autonomous_system_organization}` : ""}`
}

function StatusChip({ request }: { request: LiveRequest }) {
  return (
    <span
      style={{
        background: PACKET_COLORS[request.statusClass],
        color: "#04121a",
        borderRadius: "4px",
        padding: "1px 6px",
        fontSize: "11px",
        fontWeight: 700,
      }}
    >
      {request.log?.status_code ?? "?"}
    </span>
  )
}

function LiveRequestDetail({
  request,
  onClose,
  onOpenAlert,
  popupRef,
}: {
  request: LiveRequest
  onClose: () => void
  onOpenAlert?: (decision: DecisionRef) => void
  popupRef?: RefObject<MapLibrePopup | null>
}) {
  const log = request.log

  return (
    <PopupCard
      onClose={onClose}
      point={request.coordinates ?? undefined}
      popupRef={popupRef}
      header={
        <>
          <StatusChip request={request} />
          <span style={{ fontSize: "12px", fontWeight: 600 }}>{log?.method ?? "-"}</span>
          <span style={{ marginLeft: "auto", fontSize: "10px", color: "var(--popup-muted)" }}>
            {new Date(request.timestamp).toLocaleTimeString()}
          </span>
        </>
      }
    >
      <div style={{ fontSize: "11px", marginBottom: "8px", wordBreak: "break-all" }}>
        {log?.url ?? "No access log url data for this event"}
      </div>

      <Row
        label="IP"
        icon={<Network style={POPUP_ROW_ICON_STYLE} />}
        value={
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <IpStatusDetails
              ip={request.ip}
              context={asnText(log) ?? undefined}
              initialDecision={request.decisionType}
              onOpenAlert={onOpenAlert}
            >
              <IpLabel ip={request.ip} className="text-[12px]" />
            </IpStatusDetails>
            <InspectIpButton ip={request.ip} />
          </span>
        }
      />
      <DropPopupRow ip={request.ip} />
      <AbuseIpdbBlacklistPopupRow ip={request.ip} />
      {request.server && <Row label="Server" icon={<Server style={POPUP_ROW_ICON_STYLE} />} value={request.server} />}
      <Row
        label="Location"
        icon={<MapPin style={POPUP_ROW_ICON_STYLE} />}
        value={
          <CountryLabel code={request.countryCode}>
            {[request.city, request.countryCode && countryLabel(request.countryCode)].filter(Boolean).join(", ") || "Unknown"}
          </CountryLabel>
        }
      />
      {asnText(log) && <Row label="ASN" icon={<Building2 style={POPUP_ROW_ICON_STYLE} />} value={asnText(log)} />}
      {!request.coordinates && <Row label="Geo" icon={<MapPinOff style={POPUP_ROW_ICON_STYLE} />} value="No GeoIP match" />}
      {log && <Row label="Host" icon={<Globe style={POPUP_ROW_ICON_STYLE} />} value={log.host ?? "-"} />}
      {log && <Row label="Bytes" icon={<ArrowDownToLine style={POPUP_ROW_ICON_STYLE} />} value={formatBytes(log.bytes_sent)} />}
      {log && <Row label="Time" icon={<Timer style={POPUP_ROW_ICON_STYLE} />} value={formatDurationOrNa(log.request_time)} />}
      {log?.referrer && <Row label="Referrer" icon={<Link2 style={POPUP_ROW_ICON_STYLE} />} value={log.referrer} />}
      {log?.user_agent && <Row label="Agent" icon={<MonitorSmartphone style={POPUP_ROW_ICON_STYLE} />} value={log.user_agent} />}

      <IpBanControls ip={request.ip} initialDecision={request.decisionType} variant="footer" showBadge={false} />
    </PopupCard>
  )
}

/**
 * Anchored to the request's GeoIP origin. Callers must only render this when
 * `request.coordinates` is set - use `LiveRequestCard` otherwise.
 */
export function LiveRequestPopup({
  request,
  onClose,
  onOpenAlert,
}: {
  request: LiveRequest
  onClose: () => void
  onOpenAlert?: (decision: DecisionRef) => void
}) {
  const popupRef = useRef<MapLibrePopup>(null)
  const [longitude, latitude] = request.coordinates ?? [0, 0]

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
      maxWidth="300px"
      style={{ background: "transparent" }}
    >
      <LiveRequestDetail request={request} onClose={onClose} onOpenAlert={onOpenAlert} popupRef={popupRef} />
    </Popup>
  )
}

/**
 * Same detail, for a request with no coordinates to anchor a map `Popup` to.
 * Centered over the map rather than docked, so it never collides with the
 * corner overlays (vitals, strips, controls) or the zoom buttons.
 */
export function LiveRequestCard({
  request,
  onClose,
  onOpenAlert,
}: {
  request: LiveRequest
  onClose: () => void
  onOpenAlert?: (decision: DecisionRef) => void
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <div className="pointer-events-auto">
        <LiveRequestDetail request={request} onClose={onClose} onOpenAlert={onOpenAlert} />
      </div>
    </div>
  )
}

/** One live request on a phone, in a MapDetailPanel. A request with no GeoIP
 *  match has no point, so the map stays where it is. */
export function LiveRequestPanel({ request, onClose, onOpenAlert }: {
  request: LiveRequest
  onClose: () => void
  onOpenAlert: (decision: DecisionRef) => void
}) {
  const log = request.log
  const dropNetwork = useDropNetwork(request.ip)
  const { data: bannedIps } = useBannedIps()
  const decision = resolveDecision(bannedIps, request.ip, request.decisionType)
  const asn = asnText(log)
  return (
    <MapDetailPanel
      label="Live request"
      point={request.coordinates ?? undefined}
      onClose={onClose}
      icon={<StatusChip request={request} />}
      title={log?.method ?? "-"}
      aside={<span className="shrink-0 text-sm tabular-nums text-muted-foreground">{new Date(request.timestamp).toLocaleTimeString()}</span>}
      footer={
        <>
          <PanelInspectButton ip={request.ip} />
          <PanelBanButton ip={request.ip} initialDecision={request.decisionType} footer />
        </>
      }
    >
      <p className="mb-3 rounded-md bg-secondary px-2.5 py-2 font-mono break-all">
        {log?.url ?? "No access log url data for this event"}
      </p>
      <div className="mb-1 flex items-center gap-1 border-b border-border/60 pb-3">
        <IpStatusDetails
          ip={request.ip}
          context={[[request.city, request.countryCode && countryLabel(request.countryCode)].filter(Boolean).join(", "), asn].filter(Boolean).join(" · ")}
          initialDecision={request.decisionType}
          onOpenAlert={onOpenAlert}
        >
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 break-all font-mono text-xl">{request.ip}</span>
            {decision !== null && <DecisionBadge type={decision} />}
            {dropNetwork && <DropBadge variant="long" sblId={dropNetwork.sblId} />}
          </span>
        </IpStatusDetails>
        <CopyIpButton ip={request.ip} className="ml-auto size-11 shrink-0 [&_svg:not([class*='size-'])]:size-5" />
      </div>
      <dl>
        {request.server && <DetailField label="Server" value={request.server} />}
        <DetailField
          label="Location"
          value={
            <CountryLabel code={request.countryCode}>
              {[request.city, request.countryCode && countryLabel(request.countryCode)].filter(Boolean).join(", ") || "Unknown"}
            </CountryLabel>
          }
        />
        {asn && <DetailField label="ASN" value={asn} />}
        {!request.coordinates && <DetailField label="Geo" value="No GeoIP match" />}
        {log && <DetailField label="Host" value={log.host ?? "-"} />}
        {log && <DetailField label="Bytes" value={formatBytes(log.bytes_sent)} />}
        {log && <DetailField label="Time" value={formatDurationOrNa(log.request_time)} />}
        {log?.referrer && <DetailField label="Referrer" value={log.referrer} mono />}
        {log?.user_agent && <DetailField label="Agent" value={log.user_agent} mono />}
      </dl>
    </MapDetailPanel>
  )
}
