/**
 * Shared chrome for the map's anchored popups: glass card, close button and
 * a header row. Inline styles, matching the rest of the popup content.
 *
 * Callers leave the Popup's anchor unset so MapLibre flips it to whichever
 * side keeps it inside the map, and pass POPUP_OFFSET and usePopupPadding().
 * Side anchors keep their tip, colored in main.css; corner anchors hide it
 * and sit a few pixels off the point so the marker stays visible.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react"
import type { Offset, PaddingOptions } from "maplibre-gl"
import { useMap } from "react-map-gl/maplibre"

import { useIsMobile } from "@/hooks/use-mobile"
import { phoneActionCardTop } from "./phone-action-card"

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

/** On a phone, makes MapLibre open a popup above its point rather than behind
 *  the action card. MapLibre reads it when the popup opens. */
export function usePopupPadding(): PaddingOptions | undefined {
  const isMobile = useIsMobile()
  return useMemo(() => (isMobile ? { bottom: phoneActionCardTop() } : undefined), [isMobile])
}

/** Room kept between a popup and the map's top edge or the action card. */
const ACTION_CARD_GAP = 8
/** MapLibre's popup tip, drawn outside the card. */
const POPUP_TIP = 10
/** Pans per correction. The second covers MapLibre flipping the popup to
 *  the other side of its point after the first. */
const MAX_PANS = 2
const USER_GESTURES = ["pointerdown", "touchstart", "wheel"] as const

/**
 * On a phone, keeps an open popup whole between the map's top edge and the
 * action card. MapLibre picks the popup's side when it opens, so a tall one
 * can open below its point and run behind the card. When the popup opens or
 * grows past the card, the map pans up by the overlap. Returns the tallest
 * the popup may be, so one taller than that room scrolls instead.
 *
 * Only the popup's own changes pan the map. A user's pan is left alone, and
 * a correction the user interrupts is dropped. A popup that moves to another
 * item must remount (callers key it) to be checked again.
 */
function useClearOfActionCard(cardRef: RefObject<HTMLDivElement | null>): number | undefined {
  const { current: mapRef } = useMap()
  const isMobile = useIsMobile()
  const [maxHeight, setMaxHeight] = useState<number>()

  useEffect(() => {
    const map = mapRef?.getMap()
    const card = cardRef.current
    if (!map || !card || !isMobile) {
      setMaxHeight(undefined)
      return
    }
    const container = map.getContainer()
    const measureRoom = () =>
      setMaxHeight(container.clientHeight - phoneActionCardTop() - 2 * ACTION_CARD_GAP - POPUP_TIP)

    let pans = 0
    let lastOverlap = Infinity
    // A user's gesture ends with an originalEvent; only camera moves without
    // one (a flight that opened the popup, or this hook's own pan) recheck.
    const onMoveEnd = (event: { originalEvent?: unknown }) => {
      if (!event.originalEvent) keepClear()
    }
    const waitForMoveEnd = () => {
      map.off("moveend", onMoveEnd)
      map.once("moveend", onMoveEnd)
    }
    const cancel = () => {
      map.off("moveend", onMoveEnd)
    }

    function keepClear() {
      // Wait for a flight or zoom that opened the popup, rather than cut it short.
      if (map!.isMoving()) {
        waitForMoveEnd()
        return
      }
      const bounds = container.getBoundingClientRect()
      const rect = card!.getBoundingClientRect()
      const overlap = rect.bottom - (bounds.bottom - phoneActionCardTop() - ACTION_CARD_GAP)
      const pan = Math.min(overlap, rect.top - bounds.top - ACTION_CARD_GAP)
      // Stop when the last pan didn't help: the camera can be pinned by its
      // zoom or latitude limits.
      if (pan < 1 || pans >= MAX_PANS || overlap > lastOverlap - 1) return
      pans += 1
      lastOverlap = overlap
      // Registered first: with reduced motion the pan ends before panBy returns.
      waitForMoveEnd()
      map!.panBy([0, pan], { duration: 250 })
    }

    const correct = () => {
      pans = 0
      lastOverlap = Infinity
      keepClear()
    }

    measureRoom()
    map.on("resize", measureRoom)
    const canvas = map.getCanvasContainer()
    for (const gesture of USER_GESTURES) canvas.addEventListener(gesture, cancel, { passive: true })
    const observer = new ResizeObserver(correct)
    observer.observe(card)
    return () => {
      observer.disconnect()
      for (const gesture of USER_GESTURES) canvas.removeEventListener(gesture, cancel)
      map.off("resize", measureRoom)
      cancel()
    }
  }, [mapRef, cardRef, isMobile])

  return maxHeight
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

/** Size for the lucide icon leading a PopupRow label. */
export const POPUP_ROW_ICON_STYLE: CSSProperties = { width: 12, height: 12 }

/** Label on the left, value on the right; `icon` leads the label. */
export function PopupRow({ label, value, icon }: { label: string; value: ReactNode; icon?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", fontSize: "12px", marginBottom: "6px" }}>
      <span style={{ color: "var(--popup-muted)", display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
        {icon}
        {label}
      </span>
      <span style={{ fontWeight: 500, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  )
}

/** Count pill in the accent tone, for a popup's headline number. */
export function PopupBadge({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        background: "var(--popup-badge-bg)",
        color: "var(--popup-badge-text)",
        padding: "2px 8px",
        borderRadius: "9999px",
        fontSize: "12px",
        fontWeight: 500,
      }}
    >
      {children}
    </span>
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
  const cardRef = useRef<HTMLDivElement>(null)
  const maxHeight = useClearOfActionCard(cardRef)
  return (
    <div
      ref={cardRef}
      style={{
        // Positioned so the close button anchors to this card rather than
        // to whichever ancestor MapLibre happens to have positioned.
        position: "relative",
        background: "var(--floating-surface)",
        backdropFilter: "blur(8px)",
        color: "var(--popup-fg)",
        borderRadius: "8px",
        padding: "12px",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
        border: "1px solid var(--popup-border)",
        minWidth,
        ...(maxHeight !== undefined && { maxHeight, display: "flex", flexDirection: "column" }),
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
          flexShrink: 0,
        }}
      >
        {header}
      </div>
      <div style={maxHeight === undefined ? undefined : { minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
        {children}
      </div>
    </div>
  )
}
