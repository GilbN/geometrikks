/**
 * Mobile filter host: a compact "Filters (n)" trigger opening a drawer, from
 * the bottom or from the right on a phone held sideways, with the host's
 * filter controls stacked vertically as FilterFields. Pair FilterCombobox
 * children with forceInline so they don't nest a second drawer.
 */
import { useState, type ReactNode } from "react"
import { SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { SideDrawerClose } from "@/components/map/SideDrawer"
import { usePhoneDrawer } from "@/hooks/use-phone-drawer"

export function FiltersDrawer({
  activeCount,
  onClear,
  children,
}: {
  activeCount: number
  onClear?: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const drawer = usePhoneDrawer("filters", open, () => setOpen(false))
  return (
    <Drawer key={drawer.key} direction={drawer.direction} open={drawer.open} onOpenChange={setOpen} onClosed={drawer.onClosed}>
      <DrawerTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 pointer-coarse:h-11">
          <SlidersHorizontal className="mr-1 h-3.5 w-3.5" />
          Filters
          {activeCount > 0 && (
            <>
              {" "}
              <span className="sr-only">, active filter groups:</span>({activeCount})
            </>
          )}
        </Button>
      </DrawerTrigger>
      <DrawerContent className={drawer.contentClassName}>
        <DrawerHeader className="flex-row items-center justify-between">
          <div className={drawer.side ? "mr-auto" : undefined}>
            <DrawerTitle>Filters</DrawerTitle>
            <DrawerDescription className="sr-only">
              Adjust the table filters.
            </DrawerDescription>
          </div>
          {onClear && activeCount > 0 && (
            <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={onClear}>
              Clear filters
            </Button>
          )}
          {drawer.side && <SideDrawerClose />}
        </DrawerHeader>
        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-6">
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
