import { Info } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/** An info button for a stat card's title that opens an explanation, like AsnCategoryInfo on Analytics. */
export function StatInfo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className="tap-area size-auto shrink-0 text-muted-foreground/70 hover:text-muted-foreground pointer-coarse:min-h-0 pointer-coarse:min-w-0"
        >
          <Info className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label={label} className="w-72 space-y-2 text-sm">
        {children}
      </PopoverContent>
    </Popover>
  )
}
