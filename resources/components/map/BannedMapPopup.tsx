/**
 * Popup for the Banned IPs layer. One IP opens its details directly; a
 * location shared by several IPs lists them all, paged, and drills into one.
 * Decisions load only for the IP being looked at.
 */
import { useState } from "react"
import { Popup } from "react-map-gl/maplibre"
import { ChevronLeft, ChevronRight, Globe, Loader2, MapPin, Network, ShieldBan } from "lucide-react"
import { useIpDecisions } from "@/lib/queries"
import { formatNumber } from "@/lib/api"
import { crowdsecCtiUrl, crowdsecErrorMessage, winningDecision } from "@/lib/crowdsec"
import type { BannedMapIp } from "@/generated/api/types.gen"
import { IpBanControls } from "./IpBanControls"
import { CountryFlag, CountryLabel } from "@/components/country-flag"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import { DecisionBadge } from "@/components/crowdsec/decision-badge"
import { ExternalLinkButton } from "@/components/crowdsec/external-link"
import { POPUP_OFFSET, POPUP_CODE_STYLE, POPUP_LINK_BUTTON_STYLE, POPUP_ROW_ICON_STYLE, PopupBadge, PopupCard, PopupRow } from "./PopupCard"

const PAGE_SIZE = 20

function IpDetails({ member, onBack }: { member: BannedMapIp; onBack?: () => void }) {
  const decisions = useIpDecisions(member.ip)
  const active = decisions.data?.filter((d) => d.scope === "Ip") ?? []

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
            <code style={{ ...POPUP_CODE_STYLE, whiteSpace: "normal", overflowWrap: "anywhere" }}>{member.ip}</code>
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
      <PopupRow label="Events" value={<PopupBadge>{formatNumber(member.eventCount)}</PopupBadge>} />
      <PopupRow label="Location" icon={<MapPin style={POPUP_ROW_ICON_STYLE} />} value={member.city ?? "Unknown"} />
      {member.countryCode && (
        <PopupRow
          label="Country"
          icon={<Globe style={POPUP_ROW_ICON_STYLE} />}
          value={<CountryLabel code={member.countryCode}>{member.countryCode}</CountryLabel>}
        />
      )}

      <div style={{ paddingTop: "8px", marginTop: "8px", borderTop: "1px solid var(--popup-border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "4px", marginBottom: "6px", fontSize: "12px", color: "var(--popup-muted)" }}>
          <ShieldBan style={{ width: 12, height: 12 }} />
          <span>{decisions.isPending ? "Loading decisions..." : active.length === 1 ? "Active decision" : `${active.length} active decisions`}</span>
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
        {active.map((decision) => (
          <div key={decision.id ?? `${decision.origin}:${decision.scenario}:${decision.duration}`} style={{ fontSize: "11px", marginBottom: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <DecisionBadge type={decision.type} variant="popup" />
              <span style={{ fontWeight: 500, overflowWrap: "anywhere" }}>{decision.scenario || "No scenario given"}</span>
            </div>
            <div style={{ fontSize: "10px", color: "var(--popup-muted)" }}>{decision.origin} · {decision.duration} left</div>
          </div>
        ))}
      </div>
    </>
  )
}

function IpList({ ips, onSelect }: { ips: BannedMapIp[]; onSelect: (ip: BannedMapIp) => void }) {
  const [requestedPage, setPage] = useState(0)
  const pageCount = Math.ceil(ips.length / PAGE_SIZE)
  // A refetch can shrink the list under an open pager; clamp rather than
  // render an empty page with no way back.
  const page = Math.min(requestedPage, pageCount - 1)
  const start = page * PAGE_SIZE
  const rows = ips.slice(start, start + PAGE_SIZE)

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
            <code style={POPUP_CODE_STYLE}>{ip.ip}</code>
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

export function BannedMapPopup({
  longitude,
  latitude,
  ips,
  onClose,
}: {
  longitude: number
  latitude: number
  ips: BannedMapIp[]
  onClose: () => void
}) {
  // Only the address is state; the member resolves against the current list
  // so a refetch updates its count, and one that removes the IP falls back
  // to the list instead of showing details for an IP no longer mapped.
  const [selectedIp, setSelectedIp] = useState<string | null>(ips.length === 1 ? ips[0].ip : null)
  const selected = selectedIp === null ? null : ips.find((ip) => ip.ip === selectedIp) ?? null
  const hasIpv6 = ips.some((ip) => ip.ip.includes(":"))
  const title = selected ? "Banned IP" : `${ips.length.toLocaleString()} banned IP${ips.length === 1 ? "" : "s"}`

  return (
    <Popup
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
          closeLabel="Close banned IP popup"
          header={
            <>
              <ShieldBan style={{ width: 16, height: 16, color: "var(--destructive)", flexShrink: 0 }} />
              <span style={{ fontSize: "14px", fontWeight: 600 }}>{title}</span>
            </>
          }
        >
          {/* Bounded so a crowded location scrolls inside the card on phones. */}
          <div style={{ maxHeight: "min(320px, 40dvh)", overflowY: "auto", overscrollBehavior: "contain" }}>
            {selected
              ? <IpDetails member={selected} onBack={ips.length > 1 ? () => setSelectedIp(null) : undefined} />
              : <IpList ips={ips} onSelect={(ip) => setSelectedIp(ip.ip)} />}
          </div>
          <div style={{ paddingTop: "6px", marginTop: "6px", borderTop: "1px solid var(--popup-border)", fontSize: "10px", color: "var(--popup-muted)" }}>
            Current CrowdSec decisions seen in the selected traffic range.
          </div>
        </PopupCard>
      </div>
    </Popup>
  )
}
