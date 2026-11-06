/**
 * The phone's version of the map popups: a panel where the action card
 * sits, with 14px text and 44px buttons. It is not modal. The map above it
 * stays live, and a tap on another point swaps the panel's content. The map
 * pans the panel's point into the room left above it.
 *
 * Mounted beside the <Map>, not inside it, so MapLibre's unlayered CSS never
 * reaches it. GeoMapInner wraps both in a MapProvider for useMap().
 */
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react"
import { ScanSearch, XIcon } from "lucide-react"
import { useMap } from "react-map-gl/maplibre"
import { Button } from "@/components/ui/button"
import { useIpInspectorActions } from "@/lib/ip-inspector"
import { cn } from "@/lib/utils"
import { PHONE_ACTION_CARD_BOTTOM, safeAreaInsets } from "./phone-action-card"
import { isPhoneSideViewport, usePhoneMapSide } from "@/hooks/use-phone-map"
import { PHONE_PANEL_MAX_WIDTH, PHONE_PANEL_WIDTH_SHARE, PHONE_RAIL_EDGE, panToBox, sideVisibleBox } from "@/lib/phone-map-geometry"

/** Room kept between the point and the panel or the map's sides. */
const VIEW_MARGIN = 24
/** Clears the live vitals pill at the map's top. */
const TOP_INSET = 72
/** Pans per correction. The second covers a panel that grows as its data loads. */
const MAX_PANS = 2
const USER_GESTURES = ["pointerdown", "touchstart", "wheel"] as const
/** How long the panel waits for a closing drawer to let go of focus. */
const FOCUS_CLAIM_MS = 3000

/** Dispatched on the map container when GeoMap's focusOn has landed and stopped zooming. */
export const FOCUS_SETTLED = "focussettled"
/** On the map container while focusOn flies and zooms past the clusters. A
 *  pan then would cancel it, so the panel waits for FOCUS_SETTLED. */
export const FOCUSING_ATTRIBUTE = "data-focusing"

// Escape belongs to whatever opened on top of the panel: a menu, the ban
// dialog, the IP inspector or an alert sheet.
const OPEN_LAYER = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
].join(", ")

/**
 * Pans the map so `point` sits between the map's top and the panel, when the
 * panel opens, grows, or the map resizes. A user's gesture ends the
 * corrections for this point, so a pan the user makes stays put.
 */
function useKeepPointInView(point: readonly [number, number] | undefined, panelRef: RefObject<HTMLElement | null>) {
  const { default: mapRef } = useMap()
  const longitude = point?.[0]
  const latitude = point?.[1]

  useEffect(() => {
    const map = mapRef?.getMap()
    const panel = panelRef.current
    if (!map || !panel || longitude === undefined || latitude === undefined) return
    const container = map.getContainer()
    let pans = 0
    let userMoved = false

    // A user's gesture ends with an originalEvent; only camera moves without
    // one (the flight that opened the panel, or this hook's own pan) recheck.
    const onMoveEnd = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) return
      map.off("moveend", onMoveEnd)
      keepInView()
    }
    const waitForMoveEnd = () => {
      map.off("moveend", onMoveEnd)
      map.on("moveend", onMoveEnd)
    }

    function keepInView() {
      if (userMoved || container.hasAttribute(FOCUSING_ATTRIBUTE)) return
      if (map!.isMoving()) {
        waitForMoveEnd()
        return
      }
      const { dx, dy } = isPhoneSideViewport() ? sidePan() : bottomPan()
      if ((Math.abs(dx) < 1 && Math.abs(dy) < 1) || pans >= MAX_PANS) return
      pans += 1
      // Registered first: with reduced motion the pan ends before panBy returns.
      waitForMoveEnd()
      map!.panBy([dx, dy], { duration: 300 })
    }

    // Layout offsets, so the slide-in transform does not count. The panel
    // and the map container share an offset parent.
    function bottomPan() {
      const panelTop = panel!.offsetTop - container.offsetTop
      const width = container.clientWidth
      // A landscape phone leaves little map above the panel; the pill's
      // inset would leave none.
      const top = Math.min(TOP_INSET, panelTop / 3)
      const bottom = panelTop - VIEW_MARGIN
      const { x, y } = map!.project([longitude!, latitude!])
      const dy = y < top || y > bottom ? y - (top + bottom) / 2 : 0
      const dx = x < VIEW_MARGIN || x > width - VIEW_MARGIN ? x - width / 2 : 0
      return { dx, dy }
    }

    // Held sideways, the panel docks on the right and the point goes left of it.
    function sidePan() {
      // The vitals pill is GeoMap's, a sibling of the map container.
      const pill = container.closest("[data-geo-map]")?.querySelector("[data-live-pill]")
      const box = sideVisibleBox({
        mapWidth: container.clientWidth,
        mapHeight: container.clientHeight,
        panelLeft: panel!.offsetLeft - container.offsetLeft,
        topInset: pill ? TOP_INSET : VIEW_MARGIN,
        bottomInset: safeAreaInsets().bottom,
        margin: VIEW_MARGIN,
      })
      return panToBox(map!.project([longitude!, latitude!]), box)
    }

    const recheck = () => {
      pans = 0
      keepInView()
    }
    const onGesture = () => {
      userMoved = true
      map.off("moveend", onMoveEnd)
    }

    const canvas = map.getCanvasContainer()
    for (const gesture of USER_GESTURES) canvas.addEventListener(gesture, onGesture, { passive: true })
    map.on("resize", recheck)
    container.addEventListener(FOCUS_SETTLED, recheck)
    const observer = new ResizeObserver(recheck)
    observer.observe(panel)
    return () => {
      observer.disconnect()
      map.off("resize", recheck)
      container.removeEventListener(FOCUS_SETTLED, recheck)
      map.off("moveend", onMoveEnd)
      for (const gesture of USER_GESTURES) canvas.removeEventListener(gesture, onGesture)
    }
  }, [mapRef, panelRef, longitude, latitude])
}

export function MapDetailPanel({
  title,
  subtitle,
  icon,
  leading,
  aside,
  label,
  point,
  inline = false,
  onClose,
  closeLabel = "Close details",
  footer,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  /** Sits before the title. */
  icon?: ReactNode
  /** A back button, before the icon. */
  leading?: ReactNode
  /** Sits between the title and the close button. */
  aside?: ReactNode
  /** A fixed accessible name, for a panel whose visible title changes. */
  label?: string
  /** The coordinate the panel describes. None for a request with no GeoIP match. */
  point?: readonly [number, number]
  /** A card in the page flow under a small map, such as the Geo Logs card,
   *  instead of floating over the full-page map. It does not move the map. */
  inline?: boolean
  onClose: () => void
  closeLabel?: string
  footer?: ReactNode
  children: ReactNode
}) {
  const panelRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const side = usePhoneMapSide() && !inline
  const { default: mapRef } = useMap()
  useKeepPointInView(inline ? undefined : point, panelRef)
  // Under a map in a scrolling page the card can open below the fold.
  useEffect(() => {
    if (inline) panelRef.current?.scrollIntoView({ block: "nearest" })
  }, [inline])

  // Capture on window runs before Radix's own Escape listener on document, so
  // a layer that closes on this press still reads as open here.
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || document.querySelector(OPEN_LAYER)) return
    // An inline card shares its page with filters and tables, which keep their own Escape.
    const active = document.activeElement
    if (inline && !panelRef.current?.contains(active) && !mapRef?.getContainer().contains(active)) return
    onClose()
  })
  useEffect(() => {
    window.addEventListener("keydown", onEscape, { capture: true })
    return () => window.removeEventListener("keydown", onEscape, { capture: true })
  }, [])

  // Opened from the drawer or the live feed, focus lands on the body or the
  // action card's inert trigger once that finishes closing. The panel takes
  // it then. Focus on the map or in another control stays put.
  // The layout cleanup runs while the panel is still in the document, so
  // focus inside it can go back to the map.
  useLayoutEffect(() => {
    const panel = panelRef.current
    const deadline = performance.now() + FOCUS_CLAIM_MS
    let frame = 0
    const claim = () => {
      const active = document.activeElement
      if (!panel || panel.contains(active) || mapRef?.getContainer().contains(active)) return
      if (active === null || active === document.body || active.closest("[inert]")) {
        panel.focus({ preventScroll: true })
      } else if (performance.now() < deadline) {
        frame = requestAnimationFrame(claim)
      }
    }
    claim()
    return () => {
      cancelAnimationFrame(frame)
      if (panel?.contains(document.activeElement)) mapRef?.getCanvas().focus({ preventScroll: true })
    }
  }, [mapRef])

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      aria-labelledby={label ? undefined : titleId}
      style={
        inline
          ? undefined
          : side
            ? {
                top: 12,
                bottom: `max(12px, env(safe-area-inset-bottom, 0px))`,
                right: `max(${PHONE_RAIL_EDGE}px, env(safe-area-inset-right, 0px))`,
                width: `min(${PHONE_PANEL_MAX_WIDTH}px, ${PHONE_PANEL_WIDTH_SHARE * 100}%)`,
              }
            : { bottom: `calc(${PHONE_ACTION_CARD_BOTTOM}px + env(safe-area-inset-bottom, 0px))` }
      }
      className={cn(
        "flex flex-col overflow-hidden border border-border text-card-foreground outline-none animate-in fade-in-0 duration-200 motion-reduce:animate-none",
        inline
          ? "scroll-mt-[var(--sticky-top,0px)] scroll-mb-4 rounded-xl bg-card"
          : side
            ? "@container/panel absolute z-20 rounded-2xl bg-floating shadow-2xl shadow-black/40 backdrop-blur-sm slide-in-from-right-4"
            : "absolute left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] z-20 max-h-[min(62%,36rem)] rounded-2xl bg-floating shadow-2xl shadow-black/40 backdrop-blur-sm slide-in-from-bottom-4",
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 py-1.5 pr-1.5 pl-4 has-[[data-slot=panel-back]]:pl-1.5">
        {leading}
        {icon && <span className="flex shrink-0 items-center">{icon}</span>}
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-lg font-semibold leading-tight">{title}</h2>
          {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {aside}
        <Button variant="ghost" size="icon" className="size-11 shrink-0 rounded-full text-muted-foreground" onClick={onClose} aria-label={closeLabel}>
          <XIcon className="size-5" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 text-sm">{children}</div>
      {footer && <div className="flex shrink-0 gap-2 border-t border-border/60 p-3">{footer}</div>}
    </section>
  )
}

/** A back button for MapDetailPanel's `leading` slot. */
export function PanelBackButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button data-slot="panel-back" variant="ghost" size="icon" className="size-11 shrink-0 rounded-full" onClick={onClick} aria-label={label}>
      {children}
    </Button>
  )
}

/** Headline facts in a bordered grid divided by hairlines. A `wide` item takes a row of its own. */
export function PanelStats({ items }: { items: { label: string; value: ReactNode; accent?: boolean; wide?: boolean }[] }) {
  const columns = items.filter((item) => !item.wide).length
  return (
    <dl
      className={cn(
        "grid grid-cols-[repeat(var(--stat-columns),minmax(0,1fr))] overflow-hidden rounded-xl border border-border",
        // A side panel under 20rem has no room for three; the third takes its own row.
        columns === 3 && "@max-[20rem]/panel:grid-cols-2",
      )}
      style={{ "--stat-columns": columns } as CSSProperties}
    >
      {items.map((item, index) => (
        <div
          key={item.label}
          className={cn(
            "min-w-0 border-border px-3 py-2",
            item.wide ? "col-span-full border-t" : index < columns - 1 && "border-r",
            columns === 3 && index === 1 && "@max-[20rem]/panel:border-r-0",
            columns === 3 && index === 2 && "@max-[20rem]/panel:col-span-full @max-[20rem]/panel:border-t",
          )}
        >
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className={cn("mt-0.5 font-semibold tabular-nums leading-tight", item.accent ? "text-xl text-primary" : "text-base")}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** A section heading inside the panel body. */
export function PanelSection({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

/** The panel's IP in large monospace type, with its badges after it. */
export function PanelIp({ ip, children }: { ip: string; children?: ReactNode }) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 pb-3">
      <span className="min-w-0 break-all font-mono text-xl">{ip}</span>
      {children}
    </div>
  )
}

/** Opens the IP inspector, labelled, for a panel footer. */
export function PanelInspectButton({ ip, fromLocationId }: { ip: string; fromLocationId?: number }) {
  const { open } = useIpInspectorActions()
  return (
    <Button variant="outline" className="h-11 flex-1" aria-label={`Inspect ${ip}`} onClick={() => open(ip, fromLocationId)}>
      <ScanSearch className="size-5" />
      Inspect
    </Button>
  )
}
