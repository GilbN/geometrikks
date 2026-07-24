/**
 * Detail for one live request. Styled with inline CSS variables like MapPopup,
 * since MapLibre popups render outside the Tailwind-scoped tree.
 */
import { Popup } from "react-map-gl/maplibre"
import { Loader2, ShieldBan, ShieldOff } from "lucide-react"
import { formatBytes, formatDuration } from "@/lib/api"
import { useBanIp, useBannedIps, useCrowdsecStatus, useUnbanIp } from "@/lib/queries"
import { PACKET_COLORS } from "@/lib/live-traffic/classify"
import type { LiveRequest } from "@/lib/live-traffic/types"

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "11px", marginBottom: "4px" }}>
      <span style={{ color: "var(--popup-muted)" }}>{label}</span>
      <span style={{ fontWeight: 500, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  )
}

export function LiveRequestPopup({
  request,
  onClose,
}: {
  request: LiveRequest
  onClose: () => void
}) {
  const { data: status } = useCrowdsecStatus()
  const { data: bannedIps } = useBannedIps()
  const ban = useBanIp()
  const unban = useUnbanIp()
  const banned = bannedIps?.has(request.ip) ?? request.banned
  const isPending = ban.isPending || unban.isPending
  const log = request.log
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
      <div
        style={{
          background: "var(--card)",
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

        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", paddingBottom: "8px", borderBottom: "1px solid var(--popup-border)" }}>
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
        {log && <Row label="Host" value={log.host ?? "-"} />}
        {log && <Row label="Bytes" value={formatBytes(log.bytes_sent)} />}
        {log && <Row label="Time" value={formatDuration(log.request_time * 1000)} />}
        {log?.referrer && <Row label="Referrer" value={log.referrer} />}
        {log?.user_agent && <Row label="Agent" value={log.user_agent} />}

        {(banned || status?.write_enabled) && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px", paddingTop: "8px", borderTop: "1px solid var(--popup-border)" }}>
            {banned && (
              <span style={{ fontSize: "9px", fontWeight: 600, textTransform: "uppercase", color: "#f87171", background: "rgba(239, 68, 68, 0.15)", padding: "1px 6px", borderRadius: "9999px" }}>
                banned
              </span>
            )}
            {status?.write_enabled && (
              <button
                onClick={() => (banned ? unban.mutate(request.ip) : ban.mutate({ ip: request.ip }))}
                disabled={isPending}
                aria-label={banned ? `Unban ${request.ip}` : `Ban ${request.ip}`}
                style={{
                  marginLeft: "auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  background: "transparent",
                  border: "1px solid var(--popup-border)",
                  borderRadius: "4px",
                  padding: "2px 8px",
                  fontSize: "10px",
                  cursor: isPending ? "wait" : "pointer",
                  color: "var(--popup-muted)",
                }}
              >
                {isPending ? (
                  <Loader2 style={{ width: 12, height: 12, animation: "spin 1s linear infinite" }} />
                ) : banned ? (
                  <ShieldOff style={{ width: 12, height: 12 }} />
                ) : (
                  <ShieldBan style={{ width: 12, height: 12 }} />
                )}
                {banned ? "Unban" : "Ban"}
              </button>
            )}
          </div>
        )}
      </div>
    </Popup>
  )
}
