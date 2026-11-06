import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DrawerClose } from "@/components/ui/drawer"
import { usePhoneMapSide } from "@/hooks/use-phone-map"

// Prefixed like ui/drawer's own direction classes: unprefixed ones lose to
// them on specificity, and the drawer would stay capped at max-w-sm. The
// width is PHONE_SIDE_DRAWER_WIDTH, written out so Tailwind finds the class.
const SIDE_CONTENT = [
  "data-[vaul-drawer-direction=right]:w-[calc(384px+env(safe-area-inset-right,0px))]",
  "data-[vaul-drawer-direction=right]:max-w-none",
  "data-[vaul-drawer-direction=right]:sm:max-w-none",
  "pr-[env(safe-area-inset-right,0px)]",
].join(" ")

/** The map's drawers open from the right on a phone held sideways, from the bottom otherwise. */
export function useSideDrawer() {
  const side = usePhoneMapSide()
  return {
    side,
    direction: side ? ("right" as const) : ("bottom" as const),
    contentClassName: side ? SIDE_CONTENT : "",
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
