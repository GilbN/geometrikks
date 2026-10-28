/**
 * Popover explaining the ASN category badges, shared by the Traffic origin
 * card and the Top ASNs table. Dataset name and license live on
 * Settings > About.
 */
import { Info } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export function AsnCategoryInfo() {
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
      <PopoverContent aria-label="How ASN categories are assigned" className="w-72 text-sm">
        Networks on a bundled community list of hosting and datacenter
        operators are badged Hosting. Anything not on the list shows as
        Other, meaning unclassified, not residential. Browse the full list
        under Settings &gt; About.
      </PopoverContent>
    </Popover>
  )
}
