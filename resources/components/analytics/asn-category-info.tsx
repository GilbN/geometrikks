/**
 * The methodology disclosure for the ASN category badges, shared by the
 * Traffic origin card and the Top ASNs table so the copy cannot drift.
 * One sentence on HOW matching works; the dataset's name and license live
 * on Settings > About, where attribution belongs.
 */
import { Info } from "lucide-react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function AsnCategoryInfo() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="How ASN categories are assigned"
          className="inline-flex text-muted-foreground/70 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px]">
        Networks on a bundled community list of hosting and datacenter
        operators are badged Hosting. Anything not on the list shows as
        Other, meaning unclassified, not residential. Browse the full list
        under Settings &gt; About.
      </TooltipContent>
    </Tooltip>
  )
}
