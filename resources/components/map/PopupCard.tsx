/**
 * Shared chrome for the map's anchored popups: glass card, close button and
 * a header row. Inline styles, matching the rest of the popup content.
 *
 * The full-page map shows the same content in a MapDetailPanel on phones;
 * the Geo Logs card uses these popups at every width.
 *
 * Callers leave the Popup's anchor unset so MapLibre flips it to whichever
 * side keeps it inside the map, and pass POPUP_OFFSET.
 * Side anchors keep their tip, colored in main.css; corner anchors hide it
 * and sit a few pixels off the point so the marker stays visible.
 */
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react"
import type { Popup as MapLibrePopup, Offset } from "maplibre-gl"
import { useMap } from "react-map-gl/maplibre"

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

/** Room kept between a popup and the map's edges. */
const MAP_EDGE_GAP = 8
/** MapLibre's popup tip, drawn outside the card. */
const POPUP_TIP = 10
/** Sideways pans per correction. The second covers MapLibre flipping the
 *  popup to the other side of its point after the first. */
const MAX_PANS = 2
const USER_GESTURES = ["pointerdown", "touchstart", "wheel"] as const

/**
 * Keeps an open popup inside a map too small for it, such as the Geo Logs
 * card. The card's height is capped at the larger of the room above and below
 * its point, before MapLibre picks a side, so MapLibre places it on that side
 * and it scrolls rather than run off the map. The cap follows the point as the
 * map moves. MapLibre picks the side only when the popup moves, so a card that
 * grows or widens (its top IPs loading) asks it to pick again. A card wider
 * than half the map, which MapLibre cannot keep inside by flipping it, pans
 * the map sideways until a user's gesture. Outside a <Map> (LiveRequestCard),
 * or without a point, it does nothing.
 */
function useFitInMap(
  cardRef: RefObject<HTMLDivElement | null>,
  point: readonly [number, number] | undefined,
  popupRef: RefObject<MapLibrePopup | null> | undefined,
) {
  const { current: mapRef } = useMap()
  const longitude = point?.[0]
  const latitude = point?.[1]

  // A layout effect, so the cap is on the card before the Popup's own effect
  // adds it to the map and MapLibre measures it to pick a side.
  useLayoutEffect(() => {
    const map = mapRef?.getMap()
    const card = cardRef.current
    if (!map || !card || longitude === undefined || latitude === undefined) return
    const container = map.getContainer()
    let pans = 0
    let userMoved = false

    const capHeight = () => {
      const { y } = map.project([longitude, latitude])
      const height = container.clientHeight
      card.style.maxHeight = `${Math.max(y, height - y) - MAP_EDGE_GAP - POPUP_TIP}px`
    }

    // Only camera moves without an originalEvent (this hook's own pan) recheck.
    const onMoveEnd = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) return
      map.off("moveend", onMoveEnd)
      panSideways()
    }
    function panSideways() {
      if (userMoved || pans >= MAX_PANS) return
      if (map!.isMoving()) {
        map!.off("moveend", onMoveEnd)
        map!.on("moveend", onMoveEnd)
        return
      }
      const bounds = container.getBoundingClientRect()
      const rect = card!.getBoundingClientRect()
      // MapLibre flips a narrower card to the side with room. Before it has
      // placed the card the rect is stale, so a pan then would move the camera
      // for nothing.
      if (rect.width * 2 <= bounds.width) return
      const before = bounds.left + MAP_EDGE_GAP - rect.left
      const after = rect.right - (bounds.right - MAP_EDGE_GAP)
      const dx = before > 0 ? -before : after > 0 ? after : 0
      if (Math.abs(dx) < 1) return
      pans += 1
      // Registered first: with reduced motion the pan ends before panBy returns.
      map!.off("moveend", onMoveEnd)
      map!.on("moveend", onMoveEnd)
      map!.panBy([dx, 0], { duration: 250 })
    }
    const onGesture = () => {
      userMoved = true
      map.off("moveend", onMoveEnd)
    }

    capHeight()
    map.on("move", capHeight)
    map.on("resize", capHeight)
    const canvas = map.getCanvasContainer()
    for (const gesture of USER_GESTURES) canvas.addEventListener(gesture, onGesture, { passive: true })
    let lastSize = [card.offsetWidth, card.offsetHeight]
    let placeFrame = 0
    const observer = new ResizeObserver(() => {
      const size = [card.offsetWidth, card.offsetHeight]
      const popup = popupRef?.current
      if (popup && (Math.abs(size[0] - lastSize[0]) >= 1 || Math.abs(size[1] - lastSize[1]) >= 1)) {
        lastSize = size
        // setLngLat runs MapLibre's placement again, which picks the side anew.
        cancelAnimationFrame(placeFrame)
        placeFrame = requestAnimationFrame(() => popup.setLngLat(popup.getLngLat()))
      }
      pans = 0
      panSideways()
    })
    observer.observe(card)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(placeFrame)
      for (const gesture of USER_GESTURES) canvas.removeEventListener(gesture, onGesture)
      map.off("move", capHeight)
      map.off("resize", capHeight)
      map.off("moveend", onMoveEnd)
    }
  }, [mapRef, cardRef, popupRef, longitude, latitude])
}

export function PopupCard({
  header,
  onClose,
  closeLabel = "Close popup",
  minWidth = "220px",
  point,
  popupRef,
  children,
}: {
  header: ReactNode
  /** The popup's [longitude, latitude]; sizes the card to the room beside it. */
  point?: readonly [number, number]
  /** The Popup holding the card, so a card that grows can be placed again. */
  popupRef?: RefObject<MapLibrePopup | null>
  onClose: () => void
  closeLabel?: string
  minWidth?: string
  children: ReactNode
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  useFitInMap(cardRef, point, popupRef)
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
        display: "flex",
        flexDirection: "column",
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
      <div style={{ minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>{children}</div>
    </div>
  )
}
