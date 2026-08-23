/**
 * Mobile filter host: a compact "Filters (n)" trigger opening a bottom drawer
 * with the host's filter controls stacked vertically as FilterFields. Pair
 * FilterCombobox children with forceInline so they don't nest a second drawer.
 */
import type * as React from "react"
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

export function FiltersDrawer({
  activeCount,
  onClear,
  children,
}: {
  activeCount: number
  onClear?: () => void
  children: React.ReactNode
}) {
  return (
    <Drawer>
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
      <DrawerContent>
        <DrawerHeader className="flex-row items-center justify-between">
          <div>
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
        </DrawerHeader>
        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-6">
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
