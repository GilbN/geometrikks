/**
 * The menu in a Top ASNs row, which filters the page by the network or
 * excludes it. Desktop gets a dropdown menu and phones a drawer, like the IP
 * actions menu.
 */
import { useState } from "react"
import { EllipsisVertical } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { filterActions } from "@/components/ip-actions/ip-actions-menu"
import { SideDrawerClose } from "@/components/map/SideDrawer"
import { usePhoneDrawer } from "@/hooks/use-phone-drawer"
import type { FilterTarget } from "@/lib/ip-filter-targets"
import { usePollingHold } from "@/lib/time-range-context"

export function AsnActionsMenu({
  asn,
  organization,
  target,
}: {
  asn: number
  organization?: string | null
  target: FilterTarget
}) {
  // Auto refresh waits while the menu is open, so a reordered list can't
  // move the row out from under it.
  const [menuOpen, setMenuOpen] = useState(false)
  usePollingHold(menuOpen)
  const drawer = usePhoneDrawer("asn-actions", menuOpen, () => setMenuOpen(false))

  const label = `AS${asn}`
  const actions = filterActions(label, target)
  const trigger = (
    <Button
      variant="ghost"
      size="icon-xs"
      className="align-middle text-muted-foreground pointer-coarse:min-h-8 pointer-coarse:min-w-8"
      title="ASN actions"
      aria-label={`Actions for ${label}`}
    >
      <EllipsisVertical />
    </Button>
  )

  if (drawer.phone) {
    const heading = (
      <>
        <DrawerTitle className="font-mono">{label}</DrawerTitle>
        <DrawerDescription className="[overflow-wrap:anywhere]">{organization ?? "Unknown organization"}</DrawerDescription>
      </>
    )
    return (
      <Drawer key={drawer.key} direction={drawer.direction} open={drawer.open} onOpenChange={setMenuOpen} onClosed={drawer.onClosed}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className={drawer.contentClassName}>
          {drawer.side ? (
            <DrawerHeader className="flex-row items-start gap-2">
              <div className="min-w-0 flex-1 space-y-1">{heading}</div>
              <SideDrawerClose />
            </DrawerHeader>
          ) : (
            <DrawerHeader>{heading}</DrawerHeader>
          )}
          <div className="flex flex-col px-2 pb-6">
            {actions.map((action) => (
              <DrawerClose key={action.key} asChild>
                <Button
                  variant="ghost"
                  className="h-11 justify-start gap-3 px-3 font-normal"
                  onClick={(event) => action.run(event.currentTarget)}
                >
                  {action.icon}
                  {action.label}
                </Button>
              </DrawerClose>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <DropdownMenu open={drawer.open} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        <DropdownMenuLabel className="flex flex-col items-start gap-0.5">
          <span className="font-mono">{label}</span>
          {organization && (
            <span className="max-w-80 truncate font-normal text-muted-foreground" title={organization}>
              {organization}
            </span>
          )}
        </DropdownMenuLabel>
        {actions.map((action) => (
          <DropdownMenuItem key={action.key} onSelect={(event) => action.run(event.target as HTMLElement)}>
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
