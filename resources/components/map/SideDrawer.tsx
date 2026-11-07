import { createContext, useContext } from "react"
import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DrawerClose } from "@/components/ui/drawer"
import { usePhoneMapSide } from "@/hooks/use-phone-map"

// Prefixed like ui/drawer's own direction classes: unprefixed ones lose to
// them on specificity, and the drawer would stay capped at max-w-sm. The
// 384px is the side drawer's width, written out so Tailwind finds the class.
export const SIDE_DRAWER_CONTENT = [
  "data-[vaul-drawer-direction=right]:w-[calc(384px+env(safe-area-inset-right,0px))]",
  "data-[vaul-drawer-direction=right]:max-w-none",
  "data-[vaul-drawer-direction=right]:sm:max-w-none",
  "pr-[env(safe-area-inset-right,0px)]",
].join(" ")

/** Set by a MapDetailPanel for what it renders: phone UI, and whether it is docked on the right.
 *  An inline panel, such as the Geo Logs card, sits in the page, so its sheets follow the page. */
export const MapPanelContext = createContext<{ side: boolean; inline: boolean } | null>(null)

/** The map's drawers open from the right on a phone held sideways, from the bottom otherwise. */
export function useSideDrawer() {
  const panel = useContext(MapPanelContext)
  const pageSide = usePhoneMapSide()
  const side = panel && !panel.inline ? panel.side : pageSide
  return {
    side,
    direction: side ? ("right" as const) : ("bottom" as const),
    contentClassName: side ? SIDE_DRAWER_CONTENT : "",
  }
}

/** A side drawer has no handle to drag, so it gets a close button in its header. */
export function SideDrawerClose() {
  return (
    <DrawerClose asChild>
      <Button variant="ghost" size="icon" className="size-11 shrink-0 rounded-full text-muted-foreground" aria-label="Close">
        <XIcon className="size-5" />
      </Button>
    </DrawerClose>
  )
}
