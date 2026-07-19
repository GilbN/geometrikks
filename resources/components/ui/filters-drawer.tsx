/**
 * Mobile filter host: a compact "Filters (n)" trigger opening a bottom drawer
 * with the host's filter controls stacked vertically. Pair FilterCombobox
 * children with forceInline so they don't nest a second drawer.
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
  children,
}: {
  activeCount: number
  children: React.ReactNode
}) {
  return (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 pointer-coarse:h-10">
          <SlidersHorizontal className="mr-1 h-3.5 w-3.5" />
          Filters{activeCount > 0 && ` (${activeCount})`}
        </Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Filters</DrawerTitle>
          <DrawerDescription className="sr-only">
            Adjust the table filters.
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-6">
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

export function FilterSection({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}
