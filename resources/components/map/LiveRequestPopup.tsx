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
import { Popup } from "react-map-gl/maplibre"
import { formatBytes, formatDuration } from "@/lib/api"
import { PACKET_COLORS } from "@/lib/live-traffic/classify"
import { IpBanControls } from "./IpBanControls"
import type { LiveRequest } from "@/lib/live-traffic/types"

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "11px", marginBottom: "4px" }}>
      <span style={{ color: "var(--popup-muted)" }}>{label}</span>
      <span style={{ fontWeight: 500, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  )
}

function LiveRequestDetail({
  request,
  onClose,
}: {
  request: LiveRequest
  onClose: () => void
}) {
  const log = request.log

  return (
    <div
      style={{
        position: "relative",
        background: "color-mix(in oklab, var(--background) 85%, transparent)",
        backdropFilter: "blur(8px)",
        color: "var(--popup-fg)",
        borderRadius: "8px",
        padding: "12px",
        border: "1px solid var(--popup-border)",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
        minWidth: "220px",
      }}
    >
      <button
        onClick={onClose}
        aria-label="Close popup"
        style={{
          position: "absolute",
          top: "8px",
          right: "8px",
          background: "transparent",
          border: "none",
          color: "var(--popup-muted)",
          cursor: "pointer",
          fontSize: "18px",
          lineHeight: 1,
          padding: "2px 6px",
        }}
      >
        ×
      </button>

      {/* paddingRight clears the absolutely positioned close button, which
          otherwise sits on top of the timestamp at the end of this row. */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", paddingBottom: "8px", paddingRight: "24px", borderBottom: "1px solid var(--popup-border)" }}>
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
          {log?.status_code ?? "?"}
        </span>
        <span style={{ fontSize: "12px", fontWeight: 600 }}>{log?.method ?? "-"}</span>
        <span style={{ marginLeft: "auto", fontSize: "10px", color: "var(--popup-muted)" }}>
          {new Date(request.timestamp).toLocaleTimeString()}
        </span>
      </div>

      <div style={{ fontSize: "11px", marginBottom: "8px", wordBreak: "break-all" }}>
        {log?.url ?? "No access log line for this event"}
      </div>

      <Row label="IP" value={request.ip} />
      <Row label="Location" value={[request.city, request.countryCode].filter(Boolean).join(", ") || "Unknown"} />
      {!request.coordinates && <Row label="Geo" value="No GeoIP match" />}
      {log && <Row label="Host" value={log.host ?? "-"} />}
      {log && <Row label="Bytes" value={formatBytes(log.bytes_sent)} />}
      {log && <Row label="Time" value={formatDuration(log.request_time * 1000)} />}
      {log?.referrer && <Row label="Referrer" value={log.referrer} />}
      {log?.user_agent && <Row label="Agent" value={log.user_agent} />}

      <IpBanControls ip={request.ip} initialBanned={request.banned} variant="footer" />
    </div>
  )
}

/**
 * Anchored to the request's GeoIP origin. Callers must only render this when
 * `request.coordinates` is set - use `LiveRequestCard` otherwise.
 */
export function LiveRequestPopup({
  request,
  onClose,
}: {
  request: LiveRequest
  onClose: () => void
}) {
  const [longitude, latitude] = request.coordinates ?? [0, 0]

  return (
    <Popup
      longitude={longitude}
      latitude={latitude}
      anchor="bottom"
      onClose={onClose}
      closeButton={false}
      closeOnClick={false}
      className="geo-popup"
      maxWidth="300px"
      style={{ background: "transparent" }}
    >
      <LiveRequestDetail request={request} onClose={onClose} />
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
}: {
  request: LiveRequest
  onClose: () => void
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <div className="pointer-events-auto">
        <LiveRequestDetail request={request} onClose={onClose} />
      </div>
    </div>
  )
}
