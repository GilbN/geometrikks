import { ScanSearch } from "lucide-react"
import { Button } from "@/components/ui/button"
import { stopRowActivation } from "@/components/data/row-activation"
import { useIpInspector } from "@/lib/ip-inspector"
import { cn } from "@/lib/utils"

/** Opens the IP inspector. Safe inside activatable table rows: it stops
 *  propagation so the row's own detail sheet does not open too. A detail
 *  sheet that hosts the button closes itself through `onOpen`; closing in
 *  a capture handler instead unmounts the button before its click runs,
 *  because React flushes the close between the capture and bubble phases. */
export function InspectIpButton({
  ip,
  fromLocationId,
  className,
  onOpen,
}: {
  ip: string
  fromLocationId?: number
  className?: string
  onOpen?: () => void
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
        onOpen?.()
      }}
    >
      <ScanSearch />
    </Button>
  )
}
