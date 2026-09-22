import { useNavigate } from "@tanstack/react-router"
import { LocateFixed } from "lucide-react"
import { Button } from "@/components/ui/button"
import { stopRowActivation } from "@/components/data/row-activation"
import { flyToSearch } from "@/lib/map-filters"
import { cn } from "@/lib/utils"

/** Flies the map to where an IP was seen. With a `locationId` it lands on
 *  that location; otherwise GeoMap resolves the IP to its busiest location
 *  in the selected time range. Sits next to InspectIpButton in the IP
 *  control group and follows its row-activation and `onOpen` rules. */
export function FlyToIpButton({
  ip,
  locationId,
  className,
  onOpen,
}: {
  ip: string
  locationId?: number
  className?: string
  onOpen?: () => void
}) {
  const navigate = useNavigate()
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn("align-middle text-muted-foreground", className)}
      title="Fly to on the map"
      aria-label={`Fly to ${ip} on the map`}
      onKeyDown={stopRowActivation.onKeyDown}
      onClick={(event) => {
        event.stopPropagation()
        void navigate({
          to: "/map",
          search: (prev: Record<string, unknown>) => ({ ...prev, ...flyToSearch(ip, locationId) }),
        })
        onOpen?.()
      }}
    >
      <LocateFixed />
    </Button>
  )
}
