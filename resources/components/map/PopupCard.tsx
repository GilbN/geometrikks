/**
 * Shared chrome for the map's anchored popups: glass card, close button and
 * a header row. Inline styles, matching the rest of the popup content.
 *
 * Callers leave the Popup's anchor unset so MapLibre flips it to whichever
 * side keeps it inside the map, and pass POPUP_OFFSET. Side anchors keep
 * their tip, colored in main.css; corner anchors hide it and sit a few
 * pixels off the point so the marker stays visible.
 */
import type { CSSProperties, ReactNode } from "react"
import type { Offset } from "maplibre-gl"

export const POPUP_OFFSET: Offset = {
  center: [0, 0],
  top: [0, 0],
  bottom: [0, 0],
  left: [0, 0],
  right: [0, 0],
  "top-left": [8, 8],
  "top-right": [-8, 8],
  "bottom-left": [8, -8],
  "bottom-right": [-8, -8],
}

export const POPUP_CODE_STYLE: CSSProperties = {
  fontSize: "10px",
  background: "var(--popup-code-bg)",
  padding: "2px 6px",
  borderRadius: "4px",
  fontFamily: "monospace",
  whiteSpace: "nowrap",
}

/** Borderless text button in the popup's muted tone, for pagers and back links. */
export const POPUP_LINK_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  background: "transparent",
  border: "none",
  padding: "2px 4px",
  cursor: "pointer",
  color: "var(--popup-muted)",
  fontSize: "10px",
}

export function PopupRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "11px", marginBottom: "4px" }}>
      <span style={{ color: "var(--popup-muted)" }}>{label}</span>
      <span style={{ fontWeight: 500, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  )
}

export function PopupCard({
  header,
  onClose,
  closeLabel = "Close popup",
  minWidth = "220px",
  children,
}: {
  header: ReactNode
  onClose: () => void
  closeLabel?: string
  minWidth?: string
  children: ReactNode
}) {
  return (
    <div
      style={{
        // Positioned so the close button anchors to this card rather than
        // to whichever ancestor MapLibre happens to have positioned.
        position: "relative",
        background: "color-mix(in oklab, var(--background) 85%, transparent)",
        backdropFilter: "blur(8px)",
        color: "var(--popup-fg)",
        borderRadius: "8px",
        padding: "12px",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
        border: "1px solid var(--popup-border)",
        minWidth,
      }}
    >
      <button
        onClick={onClose}
        aria-label={closeLabel}
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
          otherwise sits on top of the header's last item. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          paddingBottom: "8px",
          paddingRight: "24px",
          marginBottom: "8px",
          borderBottom: "1px solid var(--popup-border)",
        }}
      >
        {header}
      </div>
      {children}
    </div>
  )
}
