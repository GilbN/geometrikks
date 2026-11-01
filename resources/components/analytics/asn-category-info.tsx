/**
 * Popover explaining the ASN category badges, shared by the Traffic origin
 * card and the Top ASNs tables. Dataset names and licenses live on
 * Settings > About.
 */
import { Info } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { dropAsnsLoaded } from "@/lib/drop-lists"
import { useAbout } from "@/lib/queries"

export function AsnCategoryInfo() {
  const { data: about } = useAbout()
  const dropLoaded = dropAsnsLoaded(about?.dropLists)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="How ASN categories are assigned"
          className="size-auto text-muted-foreground/70 hover:text-muted-foreground"
        >
          <Info className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="How ASN categories are assigned" className="w-72 space-y-2 text-sm">
        {dropLoaded ? (
          <>
            <p>
              Networks on the DROP list are badged DROP. The list names
              networks hijacked or run by spam and cybercrime operations, and
              it is checked first, so a DROP network never counts as Hosting.
            </p>
            <p>
              Networks on a bundled community list of hosting and datacenter
              operators are badged Hosting. Anything on neither list shows as
              Other, meaning unclassified, not residential. Both lists are
              under Settings &gt; About.
            </p>
          </>
        ) : (
          <p>
            Networks on a bundled community list of hosting and datacenter
            operators are badged Hosting. Anything not on the list shows as
            Other, meaning unclassified, not residential. Browse the full list
            under Settings &gt; About.
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
