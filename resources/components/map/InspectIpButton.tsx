/**
 * Inline-styled twin of components/ip-inspector/inspect-ip-button.tsx for
 * MapLibre popups, which render outside the Tailwind-scoped tree. Same
 * reason IpBanControls exists twice.
 */
import { ScanSearch } from "lucide-react"
import { useIpInspectorActions } from "@/lib/ip-inspector"

export function InspectIpButton({ ip, fromLocationId }: { ip: string; fromLocationId?: number }) {
  const { open } = useIpInspectorActions()
  return (
    <button
      type="button"
      title="Inspect IP"
      aria-label={`Inspect ${ip}`}
      onClick={() => open(ip, fromLocationId)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: "transparent",
        border: "none",
        padding: "2px",
        cursor: "pointer",
        color: "var(--popup-muted)",
      }}
    >
      <ScanSearch style={{ width: 12, height: 12 }} />
    </button>
  )
}
