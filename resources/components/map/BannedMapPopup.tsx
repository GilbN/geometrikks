/**
 * Popup for the Banned IPs layer. One IP opens its details directly; a
 * location shared by several IPs lists them all, paged, and drills into one.
 * Decisions load only for the IP being looked at.
 */
import { useState } from "react"
import { Popup } from "react-map-gl/maplibre"
import { ChevronLeft, ChevronRight, Loader2, ShieldBan } from "lucide-react"
import { useIpDecisions } from "@/lib/queries"
import { formatNumber } from "@/lib/api"
import { crowdsecErrorMessage } from "@/lib/crowdsec"
import type { BannedMapIp } from "@/generated/api/types.gen"
import { IpBanControls } from "./IpBanControls"
import { InspectIpButton } from "@/components/ip-inspector/inspect-ip-button"
import { POPUP_OFFSET, POPUP_CODE_STYLE, POPUP_LINK_BUTTON_STYLE, PopupCard, PopupRow } from "./PopupCard"

const PAGE_SIZE = 20

function locationLabel(ip: BannedMapIp): string {
  return [ip.city, ip.countryCode].filter(Boolean).join(", ") || "Unknown"
}

/** Remediation pill: bans red, captcha amber, anything a bouncer defines itself grey. */
function DecisionType({ type }: { type: string }) {
  const color = type === "ban" ? "var(--destructive)" : type === "captcha" ? "#f59e0b" : "var(--popup-muted)"
  return (
    <span
      style={{
        fontSize: "9px",
        fontWeight: 600,
        textTransform: "uppercase",
        color,
        background: `color-mix(in oklab, ${color} 15%, transparent)`,
        padding: "1px 5px",
        borderRadius: "9999px",
        flexShrink: 0,
      }}
    >
      {type}
    </span>
  )
}

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
        value={
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <code style={{ ...POPUP_CODE_STYLE, whiteSpace: "normal", overflowWrap: "anywhere" }}>{member.ip}</code>
            <InspectIpButton ip={member.ip} fromLocationId={member.locationId} />
          </span>
        }
      />
      <PopupRow label="Location" value={locationLabel(member)} />
      <PopupRow label="Events" value={formatNumber(member.eventCount)} />

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
              <DecisionType type={decision.type} />
              <span style={{ fontWeight: 500, overflowWrap: "anywhere" }}>{decision.scenario || "No scenario given"}</span>
            </div>
            <div style={{ fontSize: "10px", color: "var(--popup-muted)" }}>{decision.origin} · {decision.duration} left</div>
          </div>
        ))}
      </div>

      <IpBanControls ip={member.ip} initialBanned variant="footer" />
    </>
  )
}

function IpList({ ips, onSelect }: { ips: BannedMapIp[]; onSelect: (ip: BannedMapIp) => void }) {
  const [page, setPage] = useState(0)
  const pageCount = Math.ceil(ips.length / PAGE_SIZE)
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
              {(ip.city ?? ip.countryCode) && ` · ${ip.city ?? ip.countryCode}`}
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
  const [selected, setSelected] = useState<BannedMapIp | null>(ips.length === 1 ? ips[0] : null)
  const hasIpv6 = ips.some((ip) => ip.ip.includes(":"))

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
      <div role="dialog" aria-label="Banned IPs">
        <PopupCard
          onClose={onClose}
          closeLabel="Close banned IP popup"
          header={
            <>
              <ShieldBan style={{ width: 16, height: 16, color: "var(--destructive)", flexShrink: 0 }} />
              <span style={{ fontSize: "14px", fontWeight: 600 }}>
                {ips.length === 1 ? "Banned IP" : `${ips.length.toLocaleString()} banned IPs`}
              </span>
            </>
          }
        >
          {/* Bounded so a crowded location scrolls inside the card on phones. */}
          <div style={{ maxHeight: "min(320px, 40dvh)", overflowY: "auto", overscrollBehavior: "contain" }}>
            {selected
              ? <IpDetails member={selected} onBack={ips.length > 1 ? () => setSelected(null) : undefined} />
              : <IpList ips={ips} onSelect={setSelected} />}
          </div>
          <div style={{ paddingTop: "6px", marginTop: "6px", borderTop: "1px solid var(--popup-border)", fontSize: "10px", color: "var(--popup-muted)" }}>
            Current CrowdSec decisions seen in the selected traffic range.
          </div>
        </PopupCard>
      </div>
    </Popup>
  )
}
