import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { MapPanelContext, SIDE_DRAWER_CONTENT, useSideDrawer } from "@/components/map/SideDrawer"
import { usePhoneLayout } from "@/hooks/use-phone-map"
import { useOverlayEntry } from "@/lib/overlay-history"
import { useCoverBar } from "@/lib/phone-chrome"
import { drawerLayout, settleDrawerLayout, type DrawerLayout } from "@/lib/phone-layout"

export interface PhoneDrawer {
  /** Render the phone version: a drawer instead of a dialog, menu or popover. */
  phone: boolean
  /** The drawer opens from the right, at full height. */
  side: boolean
  direction: "bottom" | "right"
  contentClassName: string
  layout: DrawerLayout
  /** The open state to render with. False for the render where a rotation
   *  turned an open drawer, so the remounted one never mounts open. */
  open: boolean
  /** For the Drawer's `key`: vaul can't change direction while mounted. */
  key: DrawerLayout
  overlayId: string
}

/**
 * For an overlay with a phone version: a bottom drawer on a portrait phone,
 * a full-height drawer from the right on a phone held sideways, and the
 * desktop version otherwise. Inside a map panel the panel decides.
 *
 * An open overlay whose layout changes closes through `onClose`, unless
 * `keepWhileOpen` holds the layout it opened in. On a phone it gets a history
 * entry so Back closes it, and from the right it hides the tab bar.
 */
export function usePhoneDrawer(
  name: string,
  open: boolean,
  onClose: () => void,
  options: { phone?: boolean; keepWhileOpen?: boolean } = {},
): PhoneDrawer {
  const panel = useContext(MapPanelContext)
  const phoneLayout = usePhoneLayout()
  const sideDrawer = useSideDrawer()
  const phone = options.phone ?? (panel !== null || phoneLayout)
  const current = drawerLayout(phone, phone && sideDrawer.side)

  const [openedIn, setOpenedIn] = useState(current)
  const settled = settleDrawerLayout(current, openedIn, open, options.keepWhileOpen ?? false)
  if (!open && openedIn !== current) setOpenedIn(current)

  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    if (settled.turned) closeRef.current()
  }, [settled.turned])

  const shownOpen = open && !settled.turned
  const { layout } = settled
  const side = layout === "right"
  const overlayId = `${name}-${useId()}`
  useOverlayEntry(overlayId, layout !== "desktop" && shownOpen, onClose)
  useCoverBar(side && shownOpen)

  return {
    phone: layout !== "desktop",
    side,
    direction: side ? "right" : "bottom",
    contentClassName: side ? SIDE_DRAWER_CONTENT : "",
    layout,
    open: shownOpen,
    key: layout,
    overlayId,
  }
}
