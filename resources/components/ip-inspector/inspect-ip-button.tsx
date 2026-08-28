import { ScanSearch } from "lucide-react"
import { Button } from "@/components/ui/button"
import { stopRowActivation } from "@/components/data/row-activation"
import { useIpInspector } from "@/lib/ip-inspector"
import { cn } from "@/lib/utils"

/** Opens the IP inspector. Safe inside activatable table rows: it stops
 *  propagation so the row's own detail sheet does not open too. */
export function InspectIpButton({
  ip,
  fromLocationId,
  className,
}: {
  ip: string
  fromLocationId?: number
  className?: string
}) {
  const { open } = useIpInspector()
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn("align-middle text-muted-foreground", className)}
      title="Inspect IP"
      aria-label={`Inspect ${ip}`}
      onKeyDown={stopRowActivation.onKeyDown}
      onClick={(event) => {
        event.stopPropagation()
        open(ip, fromLocationId)
      }}
    >
      <ScanSearch />
    </Button>
  )
}
